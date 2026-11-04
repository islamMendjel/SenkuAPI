// POST /v1/chat/completions — THE EXOCORE (Run 40): the strict
// OpenAI-compatible gateway endpoint. This is the URL external CLIs
// point at:
//
//   export OPENAI_BASE_URL="http://localhost:3000/v1"
//   curl -X POST http://localhost:3000/v1/chat/completions \
//     -H "Content-Type: application/json" \
//     -d '{"model":"free/glm-5.3","messages":[{"role":"user","content":"hi"}]}'
//
// stream:true → the provider's text/event-stream bytes are forwarded
// VERBATIM (X-Accel-Buffering: no, Cache-Control: no-cache). A key
// that fails BEFORE the first streamed byte (401/403/429/5xx) is
// breaker-marked and the request transparently retries on the next
// pooled key — up to 3 retries inside the same connection — then the
// Z.ai cloud answers as last resort. Every completion is accounted
// (UsageEvent + lastUsedAt) and feeds the 24h response cache.
//
// Payload passthrough: temperature, max_tokens, top_p, stop, tools,
// tool_choice … all ride to the provider untouched; only `model`,
// `messages` and `stream` are normalized here. The client's system
// prompt is NEVER rewritten (a CLI's prompt is its own).

import { zaiCloudExec } from "@/lib/hermes/executor";
import { noteKeySuccess } from "@/lib/hermes/keyhealth";
import {
  SseAccountant,
  bridgeAuthorized,
  bridgeCorsHeaders,
  bridgeError,
  bridgePreflight,
  classifyStatus,
  computeCacheKey,
  getCached,
  putCached,
  recordBridgeUsage,
  retryAfterFrom,
  sseStream,
  synthesizeOpenAiSse,
  toCacheInput,
  withKeyFailover,
  flattenContent,
  type BridgeKey,
  type BridgeUsage,
  type OpenAIChunkShape,
} from "@/lib/hermes/bridge";
import { getActiveProvider } from "@/lib/hermes/router";
import type { ChatMessageData } from "@/lib/hermes/types";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Endpoints that rejected stream_options with a 400 naming the
 *  field (same adaptive discipline as the executor, per base URL). */
const streamUsageRejected = new Set<string>();

type UpstreamOk =
  | { kind: "sse"; res: Response }
  | { kind: "json"; json: OpenAIChunkShape };

function bridgeHeaders(extra?: Record<string, string>): Record<string, string> {
  return { ...bridgeCorsHeaders(), ...(extra ?? {}) };
}

function hermesUsageOf(json: OpenAIChunkShape): BridgeUsage {
  const prompt = json.usage?.prompt_tokens ?? 0;
  const completion =
    json.usage?.completion_tokens ??
    Math.ceil(flattenContent(json.choices?.[0]?.message?.content).length / 4);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: json.usage?.total_tokens ?? prompt + completion,
    usageReported: json.usage != null,
  };
}

/** Cloud-failover messages: flatten raw OpenAI messages to the
 *  {role, content: string} shape the Z.ai runtime accepts. */
function toCloudMessages(raw: unknown[]): ChatMessageData[] {
  const out: ChatMessageData[] = [];
  for (const m of raw) {
    const mm = (m ?? {}) as { role?: unknown; content?: unknown };
    const role = mm.role === "assistant" || mm.role === "system" ? mm.role : "user";
    const text = flattenContent(mm.content);
    if (text) out.push({ role, content: text });
  }
  return out;
}

export async function OPTIONS() {
  return bridgePreflight();
}

export async function GET() {
  return Response.json(
    {
      endpoint: "/v1/chat/completions",
      spec: "OpenAI",
      method: "POST",
      streaming: true,
      models_url: "/v1/models",
      note: "Hermes personal AI gateway — pooled keys, circuit breaker, 24h cache, Z.ai cloud failover.",
    },
    { headers: bridgeHeaders() }
  );
}

export async function POST(req: NextRequest) {
  if (!bridgeAuthorized(req)) {
    return bridgeError(401, "Invalid or missing bridge token.", "authentication_error");
  }
  const body = (await req.json().catch(() => null)) as
    | (Record<string, unknown> & {
        model?: unknown;
        messages?: unknown;
        stream?: unknown;
        stream_options?: unknown;
      })
    | null;

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return bridgeError(400, "messages array is required", "invalid_request_error");
  }

  const provider = await getActiveProvider();
  const models: string[] = JSON.parse(provider.models || "[]");
  const model =
    typeof body.model === "string" && body.model
      ? body.model
      : (models[0] ?? "free/glm-5.3");
  const wantsStream = body.stream === true;

  const cacheInput = toCacheInput(body.messages);
  const cacheKey = computeCacheKey(cacheInput.promptText, model, cacheInput.systemText);
  const id = `chatcmpl-hermes-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  // ── Cache hit — zero tokens, instant answer in either mode ──
  const cached = await getCached(cacheKey);
  if (cached) {
    const usage: BridgeUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      usageReported: false,
    };
    void recordBridgeUsage({
      providerId: provider.id,
      keyId: null,
      model,
      usage,
      multiplier: provider.tokenMultiplier,
      cached: true,
    });
    if (wantsStream) {
      const frames = synthesizeOpenAiSse({ id, created, model, content: cached.content, usage });
      return new Response(sseStream(frames), {
        headers: bridgeHeaders({
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
          "X-Hermes-Provider": provider.name,
          "X-Hermes-Failover": "cache",
        }),
      });
    }
    return Response.json(
      {
        id,
        object: "chat.completion",
        created,
        model,
        hermes: { provider: provider.name, cached: true, tokens: 0 },
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: cached.content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
      { headers: bridgeHeaders({ "X-Hermes-Failover": "cache" }) }
    );
  }

  // ── Pooled provider attempt(s) — pre-stream circuit breaker ──
  const upstreamPayload: Record<string, unknown> = { ...body };
  delete upstreamPayload.stream_options;
  upstreamPayload.model = model;
  upstreamPayload.messages = body.messages;
  upstreamPayload.stream = true;

  const baseUrl = provider.baseUrl;
  const attempt = baseUrl
    ? await withKeyFailover(
        provider,
        async (
          key: BridgeKey
        ): Promise<
          | { ok: true; value: UpstreamOk }
          | { ok: false; retry: true; reason: "auth" | "transient" | "checkin"; status?: number }
        > => {
          const withUsage = !streamUsageRejected.has(baseUrl);
          const payload = withUsage
            ? { ...upstreamPayload, stream_options: { include_usage: true } }
            : upstreamPayload;

          const doFetch = () =>
            fetch(`${baseUrl}/chat/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${key.keyValue}`,
              },
              body: JSON.stringify(payload),
              signal: req.signal,
            });

          let res = await doFetch().catch(() => null);

          // The endpoint rejected the usage OPTION (not the request):
          // remember per base URL, strip, replay once.
          if (res?.status === 400 && withUsage) {
            const text = await res.text().catch(() => "");
            if (/stream[_\s-]?options|include[_\s-]?usage/i.test(text)) {
              streamUsageRejected.add(baseUrl);
              res = await doFetch().catch(() => null);
            }
          }

          if (!res) return { ok: false, retry: true, reason: "transient" as const };
          if (!res.ok) {
            const cls = classifyStatus(res.status);
            void retryAfterFrom(res);
            return { ok: false, retry: true, reason: cls.reason, status: res.status };
          }

          const contentType = res.headers.get("content-type") ?? "";
          if (contentType.includes("text/event-stream") && res.body) {
            return { ok: true, value: { kind: "sse" as const, res } };
          }
          // 200 but not SSE — read it as JSON (endpoint ignored stream).
          const json = (await res.json().catch(() => null)) as OpenAIChunkShape | null;
          if (json?.choices?.length) {
            return { ok: true, value: { kind: "json" as const, json } };
          }
          return { ok: false, retry: true, reason: "transient" as const };
        },
        { signal: req.signal }
      )
    : ({ exhausted: true as const, attempts: 0 } as const);

  if ("result" in attempt) {
    const { key } = attempt;
    if (attempt.result.kind === "sse") {
      return serveSse({
        req,
        res: attempt.result.res,
        provider,
        key,
        model,
        cacheKey,
        wantsStream,
        id,
        created,
      });
    }
    // Full JSON arrived (endpoint ignored stream:true) — account and
    // serve in the requested mode.
    const json = attempt.result.json;
    const usage = hermesUsageOf(json);
    const content = flattenContent(json.choices?.[0]?.message?.content);
    await noteSuccessAndCache({ provider, key, model, cacheKey, usage, content });
    return serveFromContent({ content, usage, wantsStream, id, created, model, provider, key });
  }

  // ── Every pooled key failed → Z.ai cloud failover (still 100%
  //    cloud, never local). Serves honest OpenAI-shaped responses. ──
  try {
    const exec = await zaiCloudExec({
      baseUrl: null,
      apiKey: "",
      model,
      messages: toCloudMessages(body.messages),
      signal: req.signal,
    });
    const usage: BridgeUsage = {
      promptTokens: exec.promptTokens,
      completionTokens: exec.completionTokens,
      totalTokens: exec.totalTokens,
      usageReported: exec.usageReported ?? false,
    };
    void recordBridgeUsage({
      providerId: provider.id,
      keyId: null,
      model,
      usage,
      multiplier: provider.tokenMultiplier,
      cached: false,
    });
    if (exec.content.trim()) {
      void putCached({
        cacheKey,
        model,
        provider: provider.name,
        content: exec.content,
        tokens: exec.totalTokens,
      }).catch(() => undefined);
    }
    return serveFromContent({
      content: exec.content,
      usage,
      wantsStream,
      id,
      created,
      model,
      provider,
      key: null,
    });
  } catch (err) {
    const message = (err as Error).message || "All providers failed.";
    return bridgeError(502, message, "api_error", "upstream-failover-failed");
  }
}

// ── Accounting helpers ───────────────────────────────────────

async function noteSuccessAndCache(params: {
  provider: { id: string; name: string; tokenMultiplier: number };
  key: BridgeKey;
  model: string;
  cacheKey: string;
  usage: BridgeUsage;
  content: string;
}) {
  noteKeySuccess(params.key.id, true, {
    tokens: params.usage.totalTokens,
    model: params.model,
  });
  void recordBridgeUsage({
    providerId: params.provider.id,
    keyId: params.key.id,
    model: params.model,
    usage: params.usage,
    multiplier: params.provider.tokenMultiplier,
    cached: false,
  });
  if (params.content.trim()) {
    void putCached({
      cacheKey: params.cacheKey,
      model: params.model,
      provider: params.provider.name,
      content: params.content,
      tokens: params.usage.totalTokens,
    }).catch(() => undefined);
  }
}

// ── SSE verbatim passthrough ─────────────────────────────────

async function serveSse(params: {
  req: NextRequest;
  res: Response;
  provider: { id: string; name: string; tokenMultiplier: number };
  key: BridgeKey;
  model: string;
  cacheKey: string;
  wantsStream: boolean;
  id: string;
  created: number;
}) {
  const { res, provider, key, model, cacheKey, wantsStream, id, created } = params;
  const reader = res.body!.getReader();
  const accountant = new SseAccountant();

  let finished = false;
  let stall: ReturnType<typeof setTimeout> | null = null;
  const STALL_MS = 60_000;
  const bump = () => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => abortUpstream(), STALL_MS);
  };
  const abortUpstream = () => {
    try {
      void reader.cancel();
    } catch {
      // already released
    }
  };

  const finalize = async (aborted: boolean) => {
    if (finished) return;
    finished = true;
    if (stall) clearTimeout(stall);
    const usage = accountant.finish();
    if (!aborted) {
      await noteSuccessAndCache({
        provider,
        key,
        model,
        cacheKey,
        usage,
        content: accountant.content,
      });
    } else {
      // Client is gone / upstream cut — bill what was consumed.
      void recordBridgeUsage({
        providerId: provider.id,
        keyId: key.id,
        model,
        usage,
        multiplier: provider.tokenMultiplier,
        cached: false,
      });
    }
  };

  if (!wantsStream) {
    // JSON mode: aggregate the stream fully, then answer once.
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bump();
        accountant.feed(value);
      }
    } catch {
      // upstream died or client left — the partial is NEVER cached
      await finalize(true);
      return serveFromContent({
        content: accountant.content,
        usage: accountant.finish(),
        wantsStream: false,
        id,
        created,
        model,
        provider,
        key,
      });
    }
    await finalize(false);
    return serveFromContent({
      content: accountant.content,
      usage: accountant.finish(),
      wantsStream: false,
      id,
      created,
      model,
      provider,
      key,
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await finalize(false);
          controller.close();
          return;
        }
        bump();
        controller.enqueue(value); // VERBATIM byte passthrough
        accountant.feed(value); // silent accounting
      } catch {
        await finalize(true);
        controller.close(); // truncated SSE — client sees the cut
      }
    },
    async cancel() {
      // Client disconnected — stop burning upstream tokens.
      await finalize(true);
      abortUpstream();
    },
  });

  return new Response(stream, {
    headers: bridgeHeaders({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Hermes-Provider": provider.name,
      "X-Hermes-Key": key.label,
    }),
  });
}

/** Serve held content in either wire mode (cache hit, non-SSE
 *  provider answer, cloud failover). */
function serveFromContent(params: {
  content: string;
  usage: BridgeUsage;
  wantsStream: boolean;
  id: string;
  created: number;
  model: string;
  provider: { name: string; tokenMultiplier: number };
  key: BridgeKey | null;
}) {
  const { content, usage, wantsStream, id, created, model, provider, key } = params;
  if (wantsStream) {
    const frames = synthesizeOpenAiSse({ id, created, model, content, usage });
    return new Response(sseStream(frames), {
      headers: bridgeHeaders({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "X-Hermes-Provider": provider.name,
        ...(key ? { "X-Hermes-Key": key.label } : { "X-Hermes-Failover": "zai-cloud" }),
      }),
    });
  }
  return Response.json(
    {
      id,
      object: "chat.completion",
      created,
      model,
      hermes: {
        provider: provider.name,
        cached: false,
        tokens: Math.round(usage.totalTokens * provider.tokenMultiplier),
        ...(key ? { key: key.label } : { failover: true }),
      },
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
    },
    {
      headers: bridgeHeaders({
        "X-Hermes-Provider": provider.name,
        ...(key ? { "X-Hermes-Key": key.label } : { "X-Hermes-Failover": "zai-cloud" }),
      }),
    }
  );
}
