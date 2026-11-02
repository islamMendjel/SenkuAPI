// SenkuAPI — shared types (client & server safe)

export type ChatRole = "user" | "assistant" | "system";

/**
 * Effort dial — how hard the gateway works on one turn:
 *   fast   → speed-first: routed to the fastest engine in the pool,
 *            brevity directive, no deep retrieval
 *   medium → the default: your selected model, current behavior
 *   deep   → thinking mode + deep research: routed to the strongest
 *            engine in the pool, multi-round audited retrieval
 */
export type EffortLevel = "fast" | "medium" | "deep";

export interface ChatMessageData {
  role: ChatRole;
  content: string;
  /** Attachments the gateway read on this user message — the
   *  gateway appends their extracted text to the request context
   *  (never to the stored message content). Optional so messages
   *  without attachments stay byte-identical on the wire. */
  attachments?: AttachmentRecord[];
}

/**
 * One file the gateway ACTUALLY read for a user message.
 *   kind   — text (plain/code) | pdf (text-layer) | image (vision pass)
 *   method — which engine produced the extract ("text-layer" local
 *            decode / unpdf, "vision" pooled VLM)
 *   chars  — length of the extract actually sent (after the cap)
 *   totalChars — full extracted length before the cap (== chars when
 *            not truncated)
 * Failed files NEVER become records — a file whose content could
 * not be read is not sent at all, so the model can never pretend
 * to have read it.
 */
export interface AttachmentRecord {
  name: string;
  mime: string;
  kind: "text" | "pdf" | "image";
  method: "text-layer" | "vision";
  chars: number;
  totalChars: number;
  truncated: boolean;
  extract: string;
}

export interface SearchSource {
  title: string;
  url: string;
  snippet: string;
  /** Publication date as STATED by the engine or page text (never guessed); absent when none. */
  dateHint?: string;
}

export type LimiterTierKey = "monthly" | "daily" | "burst5h";

export interface TierInfo {
  key: LimiterTierKey;
  label: string;
  used: number;
  limit: number; // raw token limit
  ratio: number; // 0..1+ (1 when unlimited)
  unlimited: boolean;
}

export type PaceStatus =
  | "unlimited"
  | "on-track"
  | "steady"
  | "high-pace"
  | "exhausted";

export interface LimiterStatus {
  providerName: string;
  providerSlug: string;
  unlimited: boolean;
  multiplier: number;
  status: PaceStatus;
  statusLabel: string;
  warning: string | null;
  tiers: {
    monthly: TierInfo;
    daily: TierInfo;
    burst5h: TierInfo;
  };
  poolUsed: number; // month-to-date raw tokens across active keys
  poolLimit: number; // monthly pool across active keys (limit × keys)
  totalTokens: number; // lifetime effective tokens through provider
  activeKeys: number;
}

export interface KeyView {
  id: string;
  label: string;
  masked: string;
  isActive: boolean;
  tokensUsedThisMonth: number;
  lastUsedAt: string | null;
}

export interface ProviderView {
  id: string;
  name: string;
  slug: string;
  baseUrl: string | null;
  hasTokenLimit: boolean;
  tokenLimitPerKey: number;
  tokenMultiplier: number;
  isActive: boolean;
  models: string[];
  keys: KeyView[];
  totalTokens: number;
}

export interface UsageSnapshot {
  activeProvider: ProviderView;
  providers: ProviderView[];
  limiter: LimiterStatus;
}
