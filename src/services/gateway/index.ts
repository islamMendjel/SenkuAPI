// Senku Core Gateway Service (Microservice Domain Entrypoint)
// Orchestrates key pools, round-robin cursor, circuit breaker,
// 3-tier token limiter, exact-match cache, and compatibility bridges.

import { db } from "@/lib/db";
import { getCached, putCached, computeCacheKey } from "@/lib/hermes/cache";
import { isKeyCooling, noteKeyFailure, noteKeySuccess } from "@/lib/hermes/keyhealth";
import { dispatchCompletion } from "@/lib/hermes/dispatch";
import { getActiveProvider } from "@/lib/hermes/router";
import { runChatTurn } from "@/lib/hermes/gateway";
import { usageSnapshot, providerView } from "@/lib/hermes/serialize";
import type {
  GatewayDispatchOptions,
  GatewayDispatchResult,
  IGatewayService,
} from "./types";
import type { LimiterStatus, ProviderView } from "@/lib/hermes/types";

export * from "./types";
export {
  dispatchCompletion,
  runChatTurn,
  isKeyCooling,
  noteKeyFailure,
  noteKeySuccess,
  getCached,
  putCached,
  computeCacheKey,
};

class CoreGatewayServiceImpl implements IGatewayService {
  async checkPacing(): Promise<LimiterStatus> {
    const snapshot = await usageSnapshot();
    return snapshot.limiter;
  }

  async getProviders(): Promise<ProviderView[]> {
    const rows = await db.provider.findMany({
      orderBy: { name: "asc" },
    });

    return Promise.all(rows.map((p) => providerView(p)));
  }

  async lookupCache(hash: string): Promise<{ content: string; tokens: number } | null> {
    return getCached(hash);
  }

  async storeCache(params: {
    hash: string;
    model: string;
    provider: string;
    content: string;
    tokens: number;
  }): Promise<void> {
    await putCached({
      cacheKey: params.hash,
      model: params.model,
      provider: params.provider,
      content: params.content,
      tokens: params.tokens,
    });
  }

  async dispatchTurn(opts: GatewayDispatchOptions): Promise<GatewayDispatchResult> {
    const t0 = Date.now();

    const userMsg = opts.messages[opts.messages.length - 1]?.content || "";
    const systemPrompt = opts.systemPrompt || "";
    const cacheKey = computeCacheKey(userMsg, opts.model, systemPrompt);

    // 1. Exact-match cache lookup
    const cached = await this.lookupCache(cacheKey);
    if (cached) {
      opts.onDelta?.(cached.content);
      return {
        content: cached.content,
        model: opts.model,
        provider: "cache",
        keyLabel: null,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        cached: true,
        servedBy: "cache",
        latencyMs: Date.now() - t0,
      };
    }

    // 2. Dispatch via dispatchCompletion
    const provider = await getActiveProvider();
    const outcome = await dispatchCompletion({
      provider,
      messages: opts.messages,
      model: opts.model,
      onDelta: opts.onDelta,
      signal: opts.signal,
    });

    return {
      content: outcome.exec.content,
      model: opts.model,
      provider: provider.name,
      keyLabel: outcome.key?.label ?? null,
      tokens: outcome.exec.totalTokens,
      promptTokens: outcome.exec.promptTokens,
      completionTokens: outcome.exec.completionTokens,
      cached: false,
      servedBy: outcome.exec.servedBy === "provider" ? "provider" : "fallback",
      latencyMs: Date.now() - t0,
    };
  }
}

export const coreGateway = new CoreGatewayServiceImpl();
