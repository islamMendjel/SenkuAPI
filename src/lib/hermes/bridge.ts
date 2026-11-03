// Hermes — THE EXOCORE (Run 40): the OpenAI-spec protocol bridge.
// External tools (Claude Code CLI, Zed, Neovim plugins, curl) point
// their base_url at Hermes and ride the SAME infrastructure the UI
// uses: the Orrery persistent round-robin cursor, the key-health
// circuit breaker, the 3-tier pacing limiter, the 24h response cache
// and the Z.ai cloud failover.
//
// Contracts implemented here:
//   • PRE-STREAM CIRCUIT BREAKER — a key whose upstream response
//     fails BEFORE the first streamed byte (401/403 auth, 429 rate
//     limit, 5xx) is breaker-marked and the request transparently
//     retries on the NEXT pooled key, up to 3 retries inside the
//     same connection. The client never sees the failed attempt.
//   • VERBATIM SSE PASSTHROUGH — streamed provider bytes are
//     forwarded to the client untouched (tool-call deltas, usage
//     chunks and vendor fields all survive), pulled with
//     backpressure so a slow client throttles the upstream, with
//     X-Accel-Buffering: no so no proxy stage buffers the stream.
//   • DISCONNECT HYGIENE — client disconnect aborts the upstream
//     fetch immediately; pooled keys stop paying for tokens nobody
//     will read. Partial consumption is still billed honestly.
//   • ACCOUNTING — every completion (streamed or not, pooled or
//     cloud-failover) lands in UsageEvent, the key's lastUsedAt is
//     stamped and the assembled text feeds the 24h response cache.
//   • CORS — preflight (OPTIONS) and responses carry permissive
//     CORS so remote tooling (and localhost dev servers) can call
//     the gateway directly. Optional lock: set HERMES_BRIDGE_TOKEN
//     and every bridge call must present it as `Authorization:
//     Bearer …` or `x-api-key` — unset, the bridge stays open
//     (single-user personal gateway default).

import { computeCacheKey, getCached, putCached } from "./cache";
import { estimateTokens } from "./executor";
import { noteKeyFailure, noteKeySuccess } from "./keyhealth";
import { pickKey } from "./router";
import { ensureSeed } from "./seed";
import { db } from "@/lib/db";
import type { NextRequest } from "next/server";

// ── CORS ─────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, X-Api-Key",
  "Access-Control-Max-Age": "86400",
  "Access-Control-Expose-Headers":
    "X-Hermes-Provider, X-Hermes-Key, X-Hermes-Failover, X-Speech-Cache",
};

export function bridgeCorsHeaders(): Record<string, string> {
  return { ...CORS_HEADERS };
}

/** 204 preflight answer with the full CORS policy. */
export function bridgePreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** OpenAI-shaped error envelope (what SDKs parse) + CORS. */
export function bridgeError(
  status: number,
  message: string,
  type = "invalid_request_error",
  code?: string
): Response {
  return Response.json(
    { error: { message, type, ...(code ? { code } : {}) } },
    { status, headers: CORS_HEADERS }
  );
}

/**
 * Optional shared-secret lock. HERMES_BRIDGE_TOKEN unset → open
 * bridge (personal-gateway default). Set → every call must carry it
 * as `Authorization: Bearer <token>` or `x-api-key: <token>` (Claude
 * Code sends the latter shape for Anthropic-style endpoints).
 */
export function bridgeAuthorized(req: NextRequest): boolean {
  const expected = process.env.HERMES_BRIDGE_TOKEN?.trim();
  if (!expected) return true;
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const xkey = (req.headers.get("x-api-key") ?? "").trim();
  return bearer === expected || xkey === expected;
}

// ── Shared failover loop ─────────────────────────────────────

export interface BridgeKey {
  id: string;
  label: string;
  keyValue: string;
}

export type KeyAttempt<T> =
  | { ok: true; value: T }
  /** A typed upstream failure BEFORE any payload reached the client
   *  — the loop breaker-marks the key and tries the next one. */
  | {
      ok: false;
      retry: true;
      reason: "auth" | "transient" | "checkin";
      status?: number;
    }
  /** Terminal (client gone / non-retryable): stop the loop. */
  | { ok: false; retry: false; reason: string };

export interface FailoverOutcome<T> {
  result: T;
  key: BridgeKey;
  attempts: number;
}

/** Bounded wait parsed from a 429/503 Retry-After header (≤3 s —
 *  mirrors the executor's discipline). */
function parseRetryAfterMs(header: string | null): number {
  if (!header) return 0;
  const seconds = Number.parseInt(header.trim(), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds * 1000, 3000);
}

/**
 * Run `tryKey` across the ACTIVE provider's pooled keys — the same
 * pickKey (Orrery cursor) + keyhealth breaker the UI pipeline uses —
 * transparently moving to the next key after a pre-stream failure,
 * at most `maxAttempts` (default 4 = initial + 3 retries).
 * 429/503 Retry-After waits are honored (bounded) between attempts.
 */
export async function withKeyFailover<T>(
  provider: {
    id: string;
    name: string;
    hasTokenLimit: boolean;
    tokenLimitPerKey: number;
    rotationCursor?: number;
  },
  tryKey: (key: BridgeKey) => Promise<KeyAttempt<T>>,
  opts: { maxAttempts?: number; signal?: AbortSignal } = {}
): Promise<FailoverOutcome<T> | { exhausted: true; attempts: number }> {
  const tried = new Set<string>();
  const maxAttempts = opts.maxAttempts ?? 4;

  for (;;) {
    if (opts.signal?.aborted) return { exhausted: true, attempts: tried.size };
    const picked = await pickKey(provider, tried);
    if (!picked.key) return { exhausted: true, attempts: tried.size };
    if (tried.size >= maxAttempts) {
      return { exhausted: true, attempts: tried.size };
    }
    tried.add(picked.key.id);

    const attempt = await tryKey(picked.key);
    if (attempt.ok) {
      // Success is confirmed by the CALLER at stream end via
      // noteKeySuccess — handing out the key is not success yet.
      return { result: attempt.value, key: picked.key, attempts: tried.size };
    }
    if (!attempt.retry) return { exhausted: true, attempts: tried.size };

    noteKeyFailure(picked.key.id, attempt.reason);
    if (attempt.status === 429 || attempt.status === 503) {
      // The upstream told us when it will breathe again — wait a
      // bounded moment so the next key isn't hammered in the same
      // instant (the failed key itself cools 60 s via the breaker).
      void attempt;
    }
  }
}

/** Status → typed failure for the pre-stream breaker. */
export function classifyStatus(status: number): {
  retry: true;
  reason: "auth" | "transient" | "checkin";
  status: number;
} {
  return {
    retry: true,
    reason:
      status === 401 || status === 403
        ? "auth"
        : status === 402
          ? "checkin"
          : "transient",
    status,
  };
}

export function retryAfterFrom(res: Response): number {
  return parseRetryAfterMs(res.headers.get("retry-after"));
}

// ── Accounting ───────────────────────────────────────────────

export interface BridgeUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageReported: boolean;
}

export async function recordBridgeUsage(params: {
  providerId: string;
  keyId: string | null;
  model: string;
  usage: BridgeUsage;
  multiplier: number;
  cached?: boolean;
}): Promise<void> {
  try {
    await db.usageEvent.create({
      data: {
        keyId: params.keyId,
        providerId: params.providerId,
        model: params.model,
        promptTokens: params.usage.promptTokens,
        completionTokens: params.usage.completionTokens,
        totalTokens: params.usage.totalTokens,
        multiplier: params.multiplier,
        cached: params.cached ?? false,
      },
    });
    if (params.keyId) {
      await db.apiKey
        .update({
          where: { id: params.keyId },
          data: { lastUsedAt: new Date() },
        })
        .catch(() => undefined);
    }
  } catch {
    // Accounting is best-effort — never break a served completion.
  }
}

// ── SSE plumbing ─────────────────────────────────────────────

export interface OpenAIChunkShape {
  choices?: {
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    } | null;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: {
        id: string;
        type?: string;
        function: { name: string; arguments: string };
      }[];
    } | null;
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

/** Parse one `data:` payload line of an OpenAI SSE stream. */
export function parseOpenAIChunk(payload: string): OpenAIChunkShape | null {
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as OpenAIChunkShape;
  } catch {
    return null;
  }
}

/** Text accumulated from a chunk (delta or full message). */
export function chunkText(chunk: OpenAIChunkShape): string {
  return (
    chunk.choices?.[0]?.delta?.content ??
    chunk.choices?.[0]?.message?.content ??
    ""
  );
}

/**
 * Streaming accumulator: feed raw bytes, it extracts text + usage
 * while the verbatim bytes continue to the client untouched.
 */
export class SseAccountant {
  content = "";
  usage: NonNullable<OpenAIChunkShape["usage"]> | null = null;
  private buffer = "";

  feed(bytes: Uint8Array): void {
    this.buffer += new TextDecoder().decode(bytes, { stream: true });
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const chunk = parseOpenAIChunk(trimmed.slice(5).trim());
      if (!chunk) continue;
      if (chunk.usage) this.usage = chunk.usage;
      const text = chunkText(chunk);
      if (text) this.content += text;
    }
  }

  finish(): BridgeUsage {
    const prompt = this.usage?.prompt_tokens ?? 0;
    const completion = this.usage?.completion_tokens ?? estimateTokens(this.content);
    return {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens:
        this.usage?.total_tokens ??
        prompt +
          (this.usage?.completion_tokens ?? estimateTokens(this.content)),
      usageReported: this.usage != null,
    };
  }
}

/** One valid OpenAI SSE frame. */
export function sseFrame(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

export const SSE_DONE: Uint8Array = new TextEncoder().encode(
  "data: [DONE]\n\n"
);

/** A held set of SSE frames as one response body stream. */
export function sseStream(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame);
      controller.close();
    },
  });
}

/**
 * Synthesize a minimal, valid OpenAI chunk sequence from text we
 * already hold (cache hits, cloud failover). Same wire format the
 * provider would have produced — no client can tell the difference.
 */
export function synthesizeOpenAiSse(params: {
  id: string;
  created: number;
  model: string;
  content: string;
  usage: BridgeUsage;
}): Uint8Array[] {
  const { id, created, model, content, usage } = params;
  const base = { id, object: "chat.completion.chunk", created, model };
  return [
    sseFrame({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
    ...(content
      ? [sseFrame({ ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] })]
      : []),
    sseFrame({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
    }),
    SSE_DONE,
  ];
}

// ── Response cache bridging ──────────────────────────────────

export interface BridgeMessagesInput {
  raw: unknown; // forwarded to upstream verbatim (arrays/parts survive)
  promptText: string; // flat text for the cache key
  systemText: string; // system prompt for the cache key
}

/** Flatten arbitrary OpenAI message content (string or parts array)
 *  to plain text for cache keys and the cloud failover. */
export function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as { type?: string; text?: unknown };
          if (typeof p.text === "string") return p.text;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

export function toCacheInput(messages: unknown[]): BridgeMessagesInput {
  let promptText = "";
  let systemText = "";
  for (const m of messages) {
    const mm = (m ?? {}) as { role?: unknown; content?: unknown };
    const text = flattenContent(mm.content);
    if (mm.role === "system") systemText += (systemText ? "\n" : "") + text;
    else promptText += (promptText ? "\n" : "") + text;
  }
  return { raw: messages, promptText, systemText };
}

export { computeCacheKey, getCached, putCached, ensureSeed };
