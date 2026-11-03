// POST /api/v1/chat/completions — OpenAI-compatible passthrough.
// External tools can point their `base_url` at Hermes and get
// pooled key routing, the pacing limiter and prompt caching for free.

import { NextRequest, NextResponse } from "next/server";
import { computeCacheKey, getCached, putCached } from "@/lib/hermes/cache";
import { BASE_SYSTEM_PROMPT } from "@/lib/hermes/constants";
import { dispatchCompletion } from "@/lib/hermes/dispatch";
import { getActiveProvider } from "@/lib/hermes/router";
import { ensureSeed } from "@/lib/hermes/seed";
import { db } from "@/lib/db";
import type { ChatMessageData } from "@/lib/hermes/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function POST(req: NextRequest) {
  await ensureSeed();
  const body = await req
    .json()
    .catch(() => null as { messages?: OpenAIMessage[]; model?: string } | null);

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json(
      { error: { message: "messages array is required", type: "invalid_request_error" } },
      { status: 400 }
    );
  }

  const provider = await getActiveProvider();
  const models: string[] = JSON.parse(provider.models || "[]");
  const model =
    typeof body.model === "string" && body.model
      ? body.model
      : models[0] ?? "free/glm-5.3";

  // Normalize messages: ensure a system message with output constraints.
  const incoming: ChatMessageData[] = body.messages
    .filter((m) => m && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content }));
  const hasSystem = incoming.some((m) => m.role === "system");
  const messages: ChatMessageData[] = hasSystem
    ? incoming.map((m) =>
        m.role === "system"
          ? { role: "system", content: `${m.content}\n\n${BASE_SYSTEM_PROMPT}` }
          : m
      )
    : [{ role: "system", content: BASE_SYSTEM_PROMPT }, ...incoming];

  const prompt = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n");
  const systemPrompt =
    messages.find((m) => m.role === "system")?.content ?? BASE_SYSTEM_PROMPT;

  // Exact-match cache (24h TTL) — cached hits cost 0 tokens.
  const cacheKey = computeCacheKey(prompt, model, systemPrompt);
  const cached = await getCached(cacheKey);
  const id = `chatcmpl-hermes-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  if (cached) {
    await db.usageEvent.create({
      data: {
        keyId: null,
        providerId: provider.id,
        model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        multiplier: provider.tokenMultiplier,
        cached: true,
      },
    });
    return NextResponse.json({
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
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
  }

  // Health-aware dispatch: pooled keys are tried in round-robin,
  // dead (auth-rejected) keys are quarantined and retried around,
  // and the Z.ai cloud only serves as the last-resort failover.
  let routed: Awaited<ReturnType<typeof dispatchCompletion>>;
  try {
    routed = await dispatchCompletion({ provider, model, messages });
  } catch (err) {
    const code = (err as { code?: string }).code;
    return NextResponse.json(
      {
        error: {
          message: (err as Error).message,
          type: "rate_limit_error",
          code: code ?? "unavailable",
        },
      },
      { status: code === "no-keys" ? 500 : 429 }
    );
  }
  const exec = routed.exec;
  const key = routed.key; // null → served by the Z.ai cloud failover

  const rawTotal = exec.totalTokens;
  await db.usageEvent.create({
    data: {
      keyId: key?.id ?? null,
      providerId: provider.id,
      model,
      promptTokens: exec.promptTokens,
      completionTokens: exec.completionTokens,
      totalTokens: rawTotal,
      multiplier: provider.tokenMultiplier,
      cached: false,
    },
  });
  if (key) {
    await db.apiKey.update({
      where: { id: key.id },
      data: { lastUsedAt: new Date() },
    });
  }
  await putCached({
    cacheKey,
    model,
    provider: provider.name,
    content: exec.content,
    tokens: rawTotal,
  });

  return NextResponse.json({
    id,
    object: "chat.completion",
    created,
    model,
    hermes: {
      provider: provider.name,
      cached: false,
      tokens: Math.round(rawTotal * provider.tokenMultiplier),
      // only reported when a pooled key actually served the response
      ...(key ? { key: key.label } : { failover: true }),
    },
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
      total_tokens: rawTotal,
    },
  });
}
