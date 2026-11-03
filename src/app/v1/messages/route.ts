// POST /v1/messages — THE EXOCORE (Run 40): the Anthropic Messages
// API endpoint. This is the URL that makes Claude Code work:
//
//   export ANTHROPIC_BASE_URL="https://hermesapi.space-z.ai"
//   export ANTHROPIC_AUTH_TOKEN="…"        # optional bridge token
//   claude
//
// Claude Code's dialect (system blocks, tool_use / tool_result,
// message_start / content_block_delta / message_stop SSE) is
// translated to the pooled provider's OpenAI spec and back — tools
// included. The request rides the same Orrery round-robin, the
// pre-stream circuit breaker (401/403/429/5xx → next key, ≤3
// retries) and the Z.ai cloud failover as every other Hermes path.

import {
  bridgeAuthorized,
  bridgeCorsHeaders,
  bridgeError,
  bridgePreflight,
  classifyStatus,
  recordBridgeUsage,
  withKeyFailover,
  type BridgeKey,
} from "@/lib/hermes/bridge";
import {
  AnthropicSseTranslator,
  translateAnthropicToOpenAI,
  translateOpenAiJsonToAnthropic,
  type AnthropicBody,
  type OpenAiJsonResponse,
} from "@/lib/hermes/anthropic-bridge";
import { getActiveProvider } from "@/lib/hermes/router";
import type { ChatMessageData } from "@/lib/hermes/types";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function bridgeHeaders(extra?: Record<string, string>): Record<string, string> {
  return { ...bridgeCorsHeaders(), ...(extra ?? {}) };
}

export async function OPTIONS() {
  return bridgePreflight();
}

export async function GET() {
  return Response.json(
    {
      endpoint: "/v1/messages",
      spec: "Anthropic Messages",
      method: "POST",
      streaming: true,
      note: "Point ANTHROPIC_BASE_URL at this gateway — Claude Code rides Hermes' pooled keys.",
    },
    { headers: bridgeHeaders() }
  );
}

export async function POST(req: NextRequest) {
  if (!bridgeAuthorized(req)) {
    return bridgeError(401, "Invalid or missing bridge token.", "authentication_error");
  }
  const body = (await req.json().catch(() => null)) as AnthropicBody | null;
  if (
    !body ||
    !Array.isArray(body.messages) ||
    body.messages.length === 0
  ) {
    return bridgeError(
      400,
      "messages: at least one message is required",
      "invalid_request_error"
    );
  }

  const provider = await getActiveProvider();
  const models: string[] = JSON.parse(provider.models || "[]");

  // Model resolution: Anthropic clients often send "claude-*" model
  // ids that the free pool has never heard of — map those to the
  // provider default so the CLI works out of the box, and report the
  // mapping honestly in a response header.
  const requested =
    typeof body.model === "string" && body.model ? body.model : "";
  const known = models.includes(requested);
  const resolvedModel = requested && known ? requested : (models[0] ?? "free/glm-5.3");
  const modelMapped = Boolean(requested) && resolvedModel !== requested;

  const { payload, promptText } = translateAnthropicToOpenAI(body, resolvedModel);
  const wantsStream = body.stream === true;
  const promptTokensEstimate = Math.ceil(promptText.length / 4);

  const baseUrl = provider.baseUrl;

  const attempt = baseUrl
    ? await withKeyFailover(
        provider,
        async (
          key: BridgeKey
        ): Promise<
          | { ok: true; value: Response }
          | { ok: false; retry: true; reason: "auth" | "transient" | "checkin"; status?: number }
        > => {
          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${key.keyValue}`,
            },
            body: JSON.stringify(payload),
            signal: req.signal,
          }).catch(() => null);

          if (!res) return { ok: false, retry: true, reason: "transient" as const };
          if (!res.ok) {
            const cls = classifyStatus(res.status);
            return { ok: false, retry: true, reason: cls.reason, status: res.status };
          }
          return { ok: true, value: res };
        },
        { signal: req.signal }
      )
    : ({ exhausted: true as const, attempts: 0 } as const);

  const requestModel = requested || resolvedModel;

  if ("result" in attempt) {
    const upstream = attempt.result;
    const wantsSseUpstream = wantsStream;
    const contentType = upstream.headers.get("content-type") ?? "";

    if (wantsSseUpstream && contentType.includes("text/event-stream") && upstream.body) {
      // ── Stream: translate OpenAI chunks → Anthropic events ──
      const translator = new AnthropicSseTranslator(requestModel);
      const reader = upstream.body.getReader();
      let accounted = false;
      const account = () => {
        if (accounted) return;
        accounted = true;
        const usage = translatorUsage(translator);
        void recordBridgeUsage({
          providerId: provider.id,
          keyId: attempt.key.id,
          model: resolvedModel,
          usage,
          multiplier: provider.tokenMultiplier,
          cached: false,
        });
      };

      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              account();
              for (const frame of translator.finish()) controller.enqueue(frame);
              controller.close();
              return;
            }
            for (const frame of translator.process(value)) controller.enqueue(frame);
          } catch {
            account();
            for (const frame of translator.finish()) controller.enqueue(frame);
            controller.close();
          }
        },
        async cancel() {
          account();
          try {
            await reader.cancel();
          } catch {
            // already released
          }
        },
      });

      return new Response(stream, {
        headers: bridgeHeaders({
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
          "X-Hermes-Provider": provider.name,
          "X-Hermes-Key": attempt.key.label,
          ...(modelMapped ? { "X-Hermes-Model-Mapped": requested } : {}),
        }),
      });
    }

    // ── Non-stream (or upstream ignored stream:true): full JSON ──
    const json = (await upstream.json().catch(() => null)) as OpenAiJsonResponse | null;
    if (!json?.choices?.length) {
      return bridgeError(502, "Upstream returned an unusable response.", "api_error");
    }
    void recordBridgeUsage({
      providerId: provider.id,
      keyId: attempt.key.id,
      model: resolvedModel,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? promptTokensEstimate,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? promptTokensEstimate,
        usageReported: json.usage != null,
      },
      multiplier: provider.tokenMultiplier,
      cached: false,
    });
    const anthropic = translateOpenAiJsonToAnthropic(json, requestModel);
    return Response.json(anthropic, {
      headers: bridgeHeaders({
        "X-Hermes-Provider": provider.name,
        "X-Hermes-Key": attempt.key.label,
        ...(modelMapped ? { "X-Hermes-Model-Mapped": requested } : {}),
      }),
    });
  }

  // ── Cloud failover: translate via the Anthropic dialect ──
  try {
    const { zaiCloudExec } = await import("@/lib/hermes/executor");
    const { flattenContent } = await import("@/lib/hermes/bridge");
    // Rebuild plain messages for the cloud runtime from the translated
    // OpenAI payload (tool messages flattened to text).
    type LooseMsg = { role?: unknown; content?: unknown };
    const cloudMessages: ChatMessageData[] = ((payload.messages as LooseMsg[]) ?? [])
      .map((m): ChatMessageData => {
        const role: ChatMessageData["role"] =
          m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
        return { role, content: flattenContent(m.content) };
      })
      .filter((m) => m.content.trim());

    const exec = await zaiCloudExec({
      baseUrl: null,
      apiKey: "",
      model: resolvedModel,
      messages: cloudMessages,
      signal: req.signal,
    });
    void recordBridgeUsage({
      providerId: provider.id,
      keyId: null,
      model: resolvedModel,
      usage: {
        promptTokens: exec.promptTokens,
        completionTokens: exec.completionTokens,
        totalTokens: exec.totalTokens,
        usageReported: exec.usageReported ?? false,
      },
      multiplier: provider.tokenMultiplier,
      cached: false,
    });
    const anthropic = translateOpenAiJsonToAnthropic(
      {
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: exec.content },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: exec.promptTokens,
          completion_tokens: exec.completionTokens,
          total_tokens: exec.totalTokens,
        },
      },
      requestModel
    );
    return Response.json(anthropic, {
      headers: bridgeHeaders({
        "X-Hermes-Provider": provider.name,
        "X-Hermes-Failover": "zai-cloud",
        ...(modelMapped ? { "X-Hermes-Model-Mapped": requested } : {}),
      }),
    });
  } catch (err) {
    const message = (err as Error).message || "All providers failed.";
    return bridgeError(502, message, "api_error", "upstream-failover-failed");
  }
}

/** Pull the accumulated usage out of a translator without leaking
 *  its internals — the accountant's finish() is the source of truth. */
function translatorUsage(t: AnthropicSseTranslator): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageReported: boolean;
} {
  const u = t.usageSnapshot();
  return {
    promptTokens: u.promptTokens,
    completionTokens: u.completionTokens,
    totalTokens: u.promptTokens + u.completionTokens,
    usageReported: u.reported,
  };
}
