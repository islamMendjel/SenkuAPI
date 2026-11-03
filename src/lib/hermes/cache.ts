// Hermes — exact-match response cache.
// Key = sha256(prompt | model | system prompt), TTL 24h, stored in
// SQLite. Cache hits are served with 0 tokens spent.

import crypto from "crypto";
import { db } from "@/lib/db";
import { CACHE_TTL_HOURS } from "./constants";

export function computeCacheKey(
  prompt: string,
  model: string,
  systemPrompt: string
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([prompt, model, systemPrompt]))
    .digest("hex");
}

export interface CachedResponse {
  content: string;
  tokens: number; // tokens the original call spent (for stats only)
  createdAt: Date;
}

/** Purge expired entries (cheap, opportunistic). */
async function purgeExpired(): Promise<void> {
  try {
    await db.responseCache.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  } catch {
    // never break a request because of cache housekeeping
  }
}

export async function getCached(cacheKey: string): Promise<CachedResponse | null> {
  const hit = await db.responseCache.findUnique({ where: { cacheKey } });
  if (!hit) return null;
  if (hit.expiresAt.getTime() <= Date.now()) {
    await db.responseCache.delete({ where: { cacheKey } }).catch(() => {});
    return null;
  }
  return { content: hit.content, tokens: hit.tokens, createdAt: hit.createdAt };
}

export async function putCached(params: {
  cacheKey: string;
  model: string;
  provider: string;
  content: string;
  tokens: number;
}): Promise<void> {
  const expiresAt = new Date(
    Date.now() + CACHE_TTL_HOURS * 3600 * 1000
  );
  await db.responseCache.upsert({
    where: { cacheKey: params.cacheKey },
    create: { ...params, expiresAt },
    update: { ...params, expiresAt },
  });
  void purgeExpired();
}
