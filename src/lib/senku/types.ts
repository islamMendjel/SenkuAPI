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

/**
 * One-shot response style (Run 17 slash commands):
 *   code    → /code   — code-focused answer, no introductory chatter
 *   concise → /concise — ultra-brief answer
 * Armed in the composer, consumed by exactly one send, then cleared.
 */
export type TurnStyle = "code" | "concise";

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

/**
 * Run 22 — Image Forge dimensions. The composer's Image mode picks
 * one; the server maps it onto the engine's supported sizes.
 */
export type ImageSize = "square" | "portrait" | "landscape" | "wide";

/**
 * One image forged by the Image Forge (Run 22). Self-contained so it
 * can travel on a message, inside a variant, or alone over the wire:
 *   id     — file id on disk (includes the extension)
 *   bytes  — decoded file size
 *   ms     — wall-clock forge duration
 *   prompt — the prompt that produced it (captions, alt text, re-rolls)
 */
export interface ImageRef {
  id: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  ms: number;
  prompt: string;
}

export interface TierInfo {
  key: LimiterTierKey;
  label: string;
  used: number;
  limit: number; // raw token limit
  ratio: number; // 0..1+ (1 when unlimited)
  unlimited: boolean;
}

/**
 * Run 23 — one entry of the image Gallery: a forged image plus the
 * chat it was born in. `key` is unique per image FILE (message id +
 * file id — re-rolls of one turn produce several entries), so React
 * keys and lightbox navigation stay stable across refetches.
 */
export interface GalleryItem {
  key: string;
  chatId: string;
  chatTitle: string;
  createdAt: string; // ISO — the message's own timestamp
  image: ImageRef;
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
  /** Effective tokens since the current usage day began
   *  (01:00 → 01:00, Africa/Algiers) — the daily-resetting counter. */
  dailyTokens: number;
  /** ISO instant of the next 01:00 Africa/Algiers rollover. */
  dailyResetsAt: string;
  /** Effective tokens across every provider, all time — never resets. */
  allTimeTokens: number;
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
