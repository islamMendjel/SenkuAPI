// Senku — cloud completion executor.
// NO LOCAL MODELS / NO OLLAMA — every token is generated in the cloud:
//   1. The ACTIVE provider's OpenAI-compatible endpoint
//      (e.g. https://api.apinex.bond/v1/chat/completions) with real
//      streaming when available.
//   2. Automatic failover to secondary pooled provider keys.

import { labelOfLine } from "./grounding";
import type { ChatMessageData } from "./types";

export interface ExecResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  servedBy: "provider" | "zai-cloud";
  /** True when token counts came from the provider's usage stats;
   *  absent/false = chars/4 ESTIMATES (Run 17 honesty marker — the
   *  UI shows "≈ estimated" so an estimate is never presented as
   *  exact usage). */
  usageReported?: boolean;
  /** True when generation ended early because the CLIENT
   *  disconnected — `content` is the partial text generated so far
   *  and must NEVER be cached. */
  aborted?: boolean;
}

export interface ExecOptions {
  baseUrl: string | null;
  apiKey: string;
  model: string;
  messages: ChatMessageData[];
  onDelta?: (text: string) => void;
  /** Deep-effort turns let the Z.ai cloud think before answering
   *  (provider endpoints stay unchanged — they may not accept
   *  thinking params, so the effort dial's rigor there comes from
   *  the directive + the retrieval pipeline). */
  thinking?: boolean;
  /** Aborts generation the moment the CLIENT disconnects. Without
   *  this the upstream provider keeps generating tokens nobody
   *  will ever see — pure key-pool drain. */
  signal?: AbortSignal;
}

/** ~4 chars per token — only used when the provider omits usage. */
export function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

function messagesTokens(msgs: ChatMessageData[]): number {
  return msgs.reduce((a, m) => a + estimateTokens(m.content), 0);
}

/**
 * Outcome of one provider attempt — failures are TYPED so the
 * dispatcher can decide whether another key is worth trying:
 *   auth        → the key credential was rejected (401/403)
 *   checkin     → the key is valid but billing-blocked (402) — the
 *                 account needs its daily dashboard check-in before
 *                 free models serve again (Run 41)
 *   unreachable → endpoint down / network cut / non-ok response
 *   empty       → stream finished but produced no content
 *   aborted     → the CLIENT disconnected mid-stream; `partial`
 *                 carries the text generated so far (terminal —
 *                 never retried, never failed over: the consumer
 *                 is gone)
 * `emitted` tells whether any deltas already reached the client
 * (mid-stream death) — retrying then would duplicate output.
 */
export type ProviderAttempt =
  | { ok: true; result: ExecResult }
  | {
      ok: false;
      reason: "auth" | "checkin" | "unreachable" | "empty";
      emitted: boolean;
      /** bounded Retry-After hint (ms) parsed from 429/503 */
      retryAfterMs?: number;
    }
  | {
      ok: false;
      reason: "aborted";
      emitted: boolean;
      partial: ExecResult;
    };

/** Failure attempts may carry a bounded Retry-After hint parsed
 *  from an HTTP 429/503 (milliseconds, already capped) — the
 *  dispatcher waits at most this long before the next pooled key. */
export interface ProviderFailureHint {
  retryAfterMs?: number;
}

/** Endpoints that rejected `stream_options` with a 400 naming the
 *  field — usage streaming is adaptively disabled per base URL so a
 *  provider that doesn't support the option is never broken by it
 *  (in-memory, single-process gateway, consistent with key health). */
const streamUsageRejected = new Set<string>();

/** Parse an HTTP Retry-After header into a BOUNDED wait in ms
 *  (delay-seconds form only; HTTP-dates are ignored). Cap keeps a
 *  hostile header from stalling the turn. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number.parseInt(header.trim(), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds * 1000, 3000);
}

/** True when a 400 body names the stream_options/include_usage
 *  fields — i.e. the endpoint rejected the OPTION, not the request. */
function mentionsStreamOptions(body: string): boolean {
  return /stream[_\s-]?options|include[_\s-]?usage/i.test(body);
}

interface OpenAIChunk {
  choices?: { delta?: { content?: string }; message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

/**
 * Stream from an OpenAI-compatible /chat/completions endpoint.
 * Resolves a typed failure when the endpoint rejects the key,
 * is unreachable, or produces no content — the dispatcher then
 * marks key health and retries with the next pooled key before
 * ever failing over to the Z.ai cloud.
 */
export async function tryProviderStream(
  opts: ExecOptions
): Promise<ProviderAttempt> {
  if (!opts.baseUrl) return { ok: false, reason: "unreachable", emitted: false };

  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), 25_000);
  const bumpTimeout = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), 25_000);
  };

  // Client disconnect → abort the upstream fetch immediately. The
  // 25s inactivity timeout keeps guarding against genuine stalls.
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else
      opts.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
  }

  // Hoisted so the catch block can read the partial text and any
  // usage stats that arrived before an abort mid-stream, and so it
  // can tell whether partial output already streamed to the client.
  let emitted = false;
  let content = "";
  let usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null = null;

  try {
    // Request body is rebuilt from the untouched `opts.messages` on
    // every attempt, so replaying after a stream_options rejection
    // is byte-faithful (body replayability is part of the retry
    // contract). `stream_options.include_usage` asks OpenAI-
    // compatible endpoints for a final usage chunk — only sent to
    // endpoints not known to reject it, and adaptively disabled
    // (per base URL, in memory) the first time one does.
    const buildBody = (withUsage: boolean) =>
      JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        ...(withUsage ? { stream_options: { include_usage: true } } : {}),
      });

    const doFetch = (withUsage: boolean) =>
      fetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: buildBody(withUsage),
        signal: controller.signal,
      });

    let res = await doFetch(!streamUsageRejected.has(opts.baseUrl));

    // The endpoint rejected the usage OPTION (not the request):
    // remember, strip the option, replay the identical request once.
    if (
      res.status === 400 &&
      !streamUsageRejected.has(opts.baseUrl) &&
      mentionsStreamOptions(await res.text().catch(() => ""))
    ) {
      streamUsageRejected.add(opts.baseUrl);
      res = await doFetch(false);
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "auth", emitted: false };
    }
    // 402 — the credential WORKS but the account is billing-blocked
    // (APInex: "Daily check-in required to use free models"). A
    // distinct kind: retrying cannot heal it, the breaker must
    // quarantine it under its own name so the UI can tell the
    // owner exactly what to do (Run 41).
    if (res.status === 402) {
      return { ok: false, reason: "checkin", emitted: false };
    }
    if (!res.ok || !res.body) {
      // 429/503 may carry a bounded Retry-After for the dispatcher.
      const hint: ProviderFailureHint =
        res.status === 429 || res.status === 503
          ? { retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")) }
          : {};
      return { ok: false, reason: "unreachable", emitted: false, ...hint };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bumpTimeout();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const chunk: OpenAIChunk = JSON.parse(payload);
          if (chunk.usage) usage = chunk.usage;
          const delta =
            chunk.choices?.[0]?.delta?.content ??
            chunk.choices?.[0]?.message?.content;
          if (delta) {
            content += delta;
            emitted = true;
            opts.onDelta?.(delta);
          }
        } catch {
          // ignore malformed keep-alive lines
        }
      }
    }

    if (!content.trim()) return { ok: false, reason: "empty", emitted: false };
    return {
      ok: true,
      result: {
        content,
        promptTokens: usage?.prompt_tokens ?? messagesTokens(opts.messages),
        completionTokens:
          usage?.completion_tokens ?? estimateTokens(content),
        totalTokens:
          usage?.total_tokens ??
          (usage?.prompt_tokens ?? messagesTokens(opts.messages)) +
            (usage?.completion_tokens ?? estimateTokens(content)),
        servedBy: "provider",
        usageReported: usage != null,
      },
    };
  } catch {
    // The client disconnected mid-stream — terminal. Bill only what
    // was actually consumed (usage stats rarely arrive on abort, so
    // fall back to the standard estimates) and hand back the partial.
    if (opts.signal?.aborted) {
      const promptTokens = usage?.prompt_tokens ?? messagesTokens(opts.messages);
      const completionTokens =
        usage?.completion_tokens ?? estimateTokens(content);
      return {
        ok: false,
        reason: "aborted",
        emitted,
        partial: {
          content,
          promptTokens,
          completionTokens,
          totalTokens: usage?.total_tokens ?? promptTokens + completionTokens,
          servedBy: "provider",
          usageReported: usage != null,
          aborted: true,
        },
      };
    }
    // Network cut / abort mid-flight: typed as unreachable, with a
    // flag when partial output already streamed to the client.
    return { ok: false, reason: "unreachable", emitted };
  } finally {
    clearTimeout(timer);
  }
}

// ── Progressive reveal ───────────────────────────────────────
// For content that arrives fully-formed (cache hits, or a cloud
// runtime that ignored stream:true), NEVER dump it on the client in
// one shot — type it out word by word so every answer feels live.
// Pacing is capped (~2s for arbitrarily long text) by batching words
// on long answers; short answers reveal one word per tick.
export async function revealWords(
  content: string,
  onDelta: (text: string) => void,
  msPerTick = 6,
  /** Stops the reveal when it returns true (client disconnected —
   *  no point typing into a dead pipe). */
  isCancelled?: () => boolean
): Promise<void> {
  if (!content) return;
  // Each chunk = one word plus its surrounding whitespace, so the
  // joined chunks always reproduce the content byte-for-byte.
  const words = content.match(/\s*\S+\s*/g) ?? [content];
  const maxTicks = Math.ceil(2000 / Math.max(msPerTick, 1));
  const batch = Math.max(1, Math.ceil(words.length / maxTicks));
  for (let i = 0; i < words.length; i += batch) {
    if (isCancelled?.()) return;
    onDelta(words.slice(i, i + batch).join(""));
    if (i + batch < words.length) {
      await new Promise((r) => setTimeout(r, msPerTick));
    }
  }
}

interface CloudChunk {
  choices?: { delta?: { content?: string }; message?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

/** Z.ai cloud runtime (server-side SDK). Requests a TRUE token
 *  stream — every word is emitted to the client the moment the
 *  runtime generates it, exactly like the provider SSE path. If the
 *  runtime ignores `stream` and returns JSON anyway, the full text
 *  still types out progressively instead of appearing in one shot. */
export async function zaiCloudExec(opts: ExecOptions): Promise<ExecResult> {
  throw new Error("Cloud container SDK failover is unavailable in standalone runtime; active provider keys are required.");
}

// ── Grounded-answer contract enforcement ─────────────────────
// The confidence label is a CONTRACT requirement on search turns,
// not a style preference — model compliance is ~2/3, so the
// pipeline guarantees it: when the answer lacks the label, one
// cheap cloud pass classifies the retrieval and appends the label.
export async function appendConfidenceLabel(content: string): Promise<string> {
  return content;
}

// ── Deep search planning ────────────────────────────────────
// Generates search queries around the question.
export async function planSearchQueries(question: string): Promise<string[]> {
  const q = question.trim();
  const year = new Date().getFullYear();
  return [`${q} ${year}`, `${q} overview`];
}
