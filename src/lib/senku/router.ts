// SenkuAPI — pooled key router.
// Round-robin rotation operates STRICTLY on the ACTIVE provider's
// keys: the rotation index advances on every pick, exhausted keys
// are skipped, quarantined (circuit-broken) keys are deprioritized,
// and the next healthy key is selected.

import { db } from "@/lib/db";
import { isKeyCooling } from "./keyhealth";
import { checkKey, type KeyCheck } from "./limiter";

// In-memory rotation counters, one per provider.
const rotationCounters = new Map<string, number>();

function nextIndex(providerId: string, count: number): number {
  const next = (rotationCounters.get(providerId) ?? 0) + 1;
  rotationCounters.set(providerId, next);
  return (next - 1) % count;
}

export interface PickResult {
  key: { id: string; label: string; keyValue: string } | null;
  check: KeyCheck | null;
  reason: "ok" | "no-keys" | "exhausted" | "all-tried";
  tried: number;
}

/**
 * Pick the next key via round-robin over the provider's ACTIVE keys,
 * skipping keys blocked by any tier of the pacing limiter and — when
 * alternatives exist — keys quarantined by the health circuit breaker.
 *
 * `excludeIds` lists keys already attempted in the current turn:
 * the dispatcher retries with a DIFFERENT key, never the same one.
 * When every remaining key is quarantined, the least-bad option is
 * still to probe one (it may have recovered) rather than give up —
 * the breaker simply re-trips if the key is still dead.
 */
export async function pickKey(
  provider: { id: string; name: string; hasTokenLimit: boolean; tokenLimitPerKey: number },
  excludeIds?: ReadonlySet<string>
): Promise<PickResult> {
  const keys = await db.apiKey.findMany({
    where: { providerId: provider.id, isActive: true },
    orderBy: { createdAt: "asc" },
  });

  if (keys.length === 0) {
    return { key: null, check: null, reason: "no-keys", tried: 0 };
  }

  const fresh = excludeIds?.size
    ? keys.filter((k) => !excludeIds.has(k.id))
    : keys;

  if (fresh.length === 0) {
    return { key: null, check: null, reason: "all-tried", tried: keys.length };
  }

  // Prefer keys that are not cooling down; if ALL fresh keys are
  // quarantined, probe them anyway (last resort, see docblock).
  const ready = fresh.filter((k) => !isKeyCooling(k.id));
  const pool = ready.length ? ready : fresh;

  let tried = 0;
  for (let i = 0; i < pool.length; i++) {
    const candidate = pool[nextIndex(provider.id, pool.length)];
    tried++;
    const check = await checkKey(candidate, provider);
    if (check.allowed) {
      return {
        key: { id: candidate.id, label: candidate.label, keyValue: candidate.keyValue },
        check,
        reason: "ok",
        tried,
      };
    }
  }

  return { key: null, check: null, reason: "exhausted", tried };
}

/** Exactly ONE provider is active at any time. */
export async function getActiveProvider() {
  const active = await db.provider.findFirst({ where: { isActive: true } });
  if (active) return active;
  const first = await db.provider.findFirst({ orderBy: { createdAt: "asc" } });
  if (!first) throw new Error("No providers configured");
  await db.provider.update({ where: { id: first.id }, data: { isActive: true } });
  return first;
}

/** Switch rule: set selected provider active, all others false. */
export async function switchProvider(providerId: string) {
  const target = await db.provider.findUnique({ where: { id: providerId } });
  if (!target) throw new Error("Provider not found");
  await db.$transaction([
    db.provider.updateMany({ data: { isActive: false } }),
    db.provider.update({ where: { id: providerId }, data: { isActive: true } }),
  ]);
  rotationCounters.delete(providerId);
  return target;
}
