// Senku Core Gateway — Domain Contracts and Types.
// Decoupled proxy layer handling upstream dispatch, key rotation,
// circuit-breaking, 3-tier token pacing, and OpenAI/Anthropic bridges.

import type {
  ChatMessageData,
  LimiterStatus,
  ProviderView,
} from "@/lib/hermes/types";

export interface GatewayDispatchOptions {
  model: string;
  messages: ChatMessageData[];
  systemPrompt?: string;
  stream?: boolean;
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface GatewayDispatchResult {
  content: string;
  model: string;
  provider: string;
  keyLabel: string | null;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  cached: boolean;
  servedBy: "provider" | "fallback" | "cache";
  latencyMs: number;
}

export interface IGatewayService {
  dispatchTurn(opts: GatewayDispatchOptions): Promise<GatewayDispatchResult>;
  checkPacing(): Promise<LimiterStatus>;
  getProviders(): Promise<ProviderView[]>;
  lookupCache(hash: string): Promise<{ content: string; tokens: number } | null>;
  storeCache(params: {
    hash: string;
    model: string;
    provider: string;
    content: string;
    tokens: number;
  }): Promise<void>;
}
