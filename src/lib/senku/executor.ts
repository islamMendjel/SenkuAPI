// SenkuAPI — cloud completion executor.
// NO LOCAL MODELS / NO OLLAMA — every token is generated in the cloud:
//   1. The ACTIVE provider's OpenAI-compatible endpoint
//      (e.g. https://api.apinex.bond/v1/chat/completions) with real
//      streaming when available.
//   2. Automatic failover to the Z.ai cloud runtime when the provider
//      endpoint is unreachable — still 100% cloud, never local.

import ZAI from "z-ai-web-dev-sdk";
import { labelOfLine } from "./grounding";
import type { ChatMessageData } from "./types";

export interface ExecResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  servedBy: "provider" | "zai-cloud";
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
  | { ok: false; reason: "auth" | "unreachable" | "empty"; emitted: boolean }
  | { ok: false; reason: "aborted"; emitted: boolean; partial: ExecResult };

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
    const res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
      }),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "auth", emitted: false };
    }
    if (!res.ok || !res.body) return { ok: false, reason: "unreachable", emitted: false };

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
  const zai = await ZAI.create();
  const completion = await zai.chat.completions.create({
    messages: opts.messages,
    thinking: { type: opts.thinking === true ? "enabled" : "disabled" },
    stream: true,
  });

  let content = "";
  let usage: CloudChunk["usage"] = null;
  let aborted = false;

  if (
    completion &&
    typeof (completion as ReadableStream<Uint8Array>).getReader === "function"
  ) {
    // Real SSE stream (OpenAI chunk shape) — parse and emit live.
    // Each read checks the client signal: a disconnected consumer
    // stops draining the cloud stream immediately.
    const reader = (completion as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      if (opts.signal?.aborted) {
        aborted = true;
        try {
          await reader.cancel();
        } catch {
          // stream already released
        }
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const chunk: CloudChunk = JSON.parse(payload);
          if (chunk.usage) usage = chunk.usage;
          const delta =
            chunk.choices?.[0]?.delta?.content ??
            chunk.choices?.[0]?.message?.content;
          if (delta) {
            content += delta;
            opts.onDelta?.(delta);
          }
        } catch {
          // ignore malformed keep-alive lines
        }
      }
    }
  } else {
    // Runtime ignored stream:true and returned plain JSON — reveal
    // the complete text progressively (never a single-shot dump).
    const json = completion as {
      choices?: { message?: { content?: string } }[];
      usage?: CloudChunk["usage"];
    } | null;
    content = json?.choices?.[0]?.message?.content ?? "";
    usage = json?.usage ?? null;
    if (content && opts.onDelta) {
      await revealWords(content, opts.onDelta);
    }
  }

  // An aborted turn may legitimately have no content — the client
  // left before the first token. That is not an error.
  if (!content.trim() && !aborted) {
    throw new Error("Cloud runtime returned an empty response");
  }

  const promptTokens = usage?.prompt_tokens ?? messagesTokens(opts.messages);
  const completionTokens = usage?.completion_tokens ?? estimateTokens(content);

  return {
    content,
    promptTokens,
    completionTokens,
    totalTokens: usage?.total_tokens ?? promptTokens + completionTokens,
    servedBy: "zai-cloud",
    ...(aborted ? { aborted: true } : {}),
  };
}

// ── Grounded-answer contract enforcement ─────────────────────
// The confidence label is a CONTRACT requirement on search turns,
// not a style preference — model compliance is ~2/3, so the
// pipeline guarantees it: when the answer lacks the label, one
// cheap cloud pass classifies the retrieval and appends the label.
const CONFIDENCE_SYSTEM =
  "You audit grounded answers for retrieval quality. Classify the retrieval behind the " +
  "answer you are given: [confirmed] = claims are dated, inside the question's time scope, " +
  "and from authoritative sources; [partial] = some claims lack dates, scope match or " +
  "authority; [stale sources] = the best sources predate the question's time scope. " +
  "Reply with ONLY the label — one line, exactly [confirmed], [partial] or [stale sources].";

export async function appendConfidenceLabel(content: string): Promise<string> {
  try {
    const zai = await ZAI.create();
    const res = await zai.chat.completions.create({
      messages: [
        { role: "system", content: CONFIDENCE_SYSTEM },
        { role: "user", content: content.slice(-1500) },
      ],
      thinking: { type: "disabled" },
    });
    const raw: string = res?.choices?.[0]?.message?.content ?? "";
    const firstLine = raw.trim().split("\n")[0] ?? "";
    let label = labelOfLine(firstLine);
    if (!label && firstLine.length <= 40) {
      // short bare replies like "partial." — match the single word
      const m = /\b(confirmed|partial|stale sources)\b/i.exec(firstLine);
      if (m) label = m[1].toLowerCase() as "confirmed" | "partial" | "stale sources";
    }
    if (!label) return content; // never fabricate — leave unchanged
    return `${content.trimEnd()}\n\n[${label}]`;
  } catch {
    return content; // corrective pass is best-effort
  }
}

// ── Deep search planning ────────────────────────────────────
// One cheap cloud pass decomposes a question into targeted search
// queries (different angles, different phrasings, a time-scoped
// variant) so the deep pipeline retrieves around the question
// instead of just at it. Thinking stays disabled — planning must
// be fast, and the rigor belongs to the synthesis pass.
const QUERY_PLAN_SYSTEM =
  "You plan web searches. Given a question, output 2-3 additional search queries " +
  "that would help answer it BETTER than searching the question verbatim: " +
  "different phrasings, the specific sub-facts needed, and when the question is " +
  "time-sensitive one query with the current year. Reply with ONLY a JSON array " +
  "of strings, nothing else. Example: [\"query one\", \"query two\"]";

export async function planSearchQueries(question: string): Promise<string[]> {
  try {
    const zai = await ZAI.create();
    const res = await zai.chat.completions.create({
      messages: [
        { role: "system", content: QUERY_PLAN_SYSTEM },
        { role: "user", content: question.slice(0, 1200) },
      ],
      thinking: { type: "disabled" },
    });
    const raw: string = res?.choices?.[0]?.message?.content ?? "";
    // Tolerate code fences and prose around the array.
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (q): q is string =>
          typeof q === "string" && q.trim().length > 2 && q.trim().length <= 200
      )
      .map((q) => q.trim())
      .slice(0, 3);
  } catch {
    return []; // planner is best-effort — deep search still runs round 1
  }
}
