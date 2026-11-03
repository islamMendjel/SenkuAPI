// Hermes — pooled key router (Run 35: THE ORRERY).
// Round-robin rotation operates STRICTLY on the ACTIVE provider's
// keys. The rotation is a PERSISTENT POSITIONAL CURSOR:
//
//   • The cursor is an index into the provider's ACTIVE keys in
//     canonical ring order (createdAt asc) — the seat that serves
//     NEXT. It lives in SQLite (Provider.rotationCursor), so it
//     survives restarts and redeploys instead of resetting to
//     seat 0 and hammering the first key after every boot.
//   • It advances by EXACTLY ONE seat past each key it hands out
//     (limiter-allowed) — never per candidate inspection — so the
//     ring is perfectly even regardless of quarantine skips,
//     limiter blocks or in-turn retries (the old global-counter-
//     mod-pool-size scheme warped distribution whenever the pool
//     shrank mid-flight). A key that fails at the STREAM level
//     after being handed out is thereby scanned past on the next
//     turn too — dead keys never pin the rotation, and the health
//     breaker soon quarantines them so they are skipped for free.
//   • A turn that serves NOTHING leaves the cursor untouched:
//     the next request retries from the same seat (starvation-
//     free — a temporarily dead seat never eats a rotation).
//   • Exhausted keys (limiter) and quarantined keys (circuit
//     breaker) are scanned PAST, not onto: the cursor only ever
//     lands on a key that actually served. When every remaining
//     key is quarantined, the least-bad option is still to probe
//     one (it may have recovered) — the breaker simply re-trips
//     if the key is still dead.
//   • switchProvider resets the cursor to 0: a fresh cycle on a
//     freshly activated pool.

import { db } from "@/lib/db";
import { isKeyCooling } from "./keyhealth";
import { checkKey, type KeyCheck } from "./limiter";

// Write-behind cache of Provider.rotationCursor. Read-through on
// first pick after boot (or after a provider switch); every advance
// updates the cache synchronously and persists to SQLite fire-and-
// forget. Single-process personal gateway: the cache is coherent.
const cursorCache = new Map<string, number>();

/** Cursor for a provider — cache first, DB on miss. */
async function readCursor(providerId: string): Promise<number> {
  const cached = cursorCache.get(providerId);
  if (cached !== undefined) return cached;
  const row = await db.provider.findUnique({
    where: { id: providerId },
    select: { rotationCursor: true },
  });
  const cursor = row?.rotationCursor ?? 0;
  cursorCache.set(providerId, cursor);
  return cursor;
}

/** Advance the cursor after a successful serve (one seat past the
 *  key that just served). Synchronous cache, async DB persist. */
function advanceCursor(
  providerId: string,
  servedSeat: number,
  ringSize: number
): void {
  const next = ringSize > 0 ? (servedSeat + 1) % ringSize : 0;
  cursorCache.set(providerId, next);
  void db.provider
    .update({ where: { id: providerId }, data: { rotationCursor: next } })
    .catch(() => {
      // DB persist is best-effort; the cache stays authoritative
      // for this process lifetime either way.
    });
}

export interface PickResult {
  key: { id: string; label: string; keyValue: string } | null;
  check: KeyCheck | null;
  reason: "ok" | "no-keys" | "exhausted" | "all-tried";
  tried: number;
  /** Seat (canonical index) of the picked key — null when none. */
  seat: number | null;
}

/**
 * Pick the next key via the persistent round-robin cursor over the
 * provider's ACTIVE keys, starting the scan AT the cursor seat and
 * walking the ring forward:
 *   cursor seat → cursor+1 → … wrapping → cursor-1.
 * Keys blocked by any tier of the pacing limiter are skipped; keys
 * quarantined by the health circuit breaker are skipped when
 * alternatives exist.
 *
 * `excludeIds` lists keys already attempted in the current turn:
 * the dispatcher retries with a DIFFERENT key, never the same one.
 */
export async function pickKey(
  provider: {
    id: string;
    name: string;
    hasTokenLimit: boolean;
    tokenLimitPerKey: number;
    rotationCursor?: number;
  },
  excludeIds?: ReadonlySet<string>
): Promise<PickResult> {
  const keys = await db.apiKey.findMany({
    where: { providerId: provider.id, isActive: true },
    orderBy: { createdAt: "asc" },
  });

  if (keys.length === 0) {
    return { key: null, check: null, reason: "no-keys", tried: 0, seat: null };
  }

  // The dispatcher narrows the provider type; when it carries the
  // row's cursor it is used to prime the cache (zero extra reads).
  if (provider.rotationCursor !== undefined) {
    if (!cursorCache.has(provider.id)) {
      cursorCache.set(provider.id, provider.rotationCursor);
    }
  }

  const fresh = excludeIds?.size
    ? keys.filter((k) => !excludeIds.has(k.id))
    : keys;

  if (fresh.length === 0) {
    return { key: null, check: null, reason: "all-tried", tried: keys.length, seat: null };
  }

  // Prefer keys that are not cooling down; if ALL fresh keys are
  // quarantined, probe them anyway (last resort, see docblock).
  const ready = fresh.filter((k) => !isKeyCooling(k.id));
  const pool = ready.length ? ready : fresh;
  // Fresh keys are a subsequence of the canonical ring — precompute
  // each pool member's SEAT so the cursor lands on true ring
  // positions even while skipping.
  const seatOf = new Map<string, number>(
    keys.map((k, i) => [k.id, i] as const)
  );
  const poolSeats = pool.map((k) => seatOf.get(k.id) ?? 0);

  const cursor = await readCursor(provider.id);
  const startSeat = ((cursor % keys.length) + keys.length) % keys.length;

  // Visit order: pool members sorted by ring distance from the
  // cursor seat (wrap-aware) — the natural "walk the ring forward".
  const order = pool
    .map((k, idx) => ({
      key: k,
      seat: poolSeats[idx],
      dist: (poolSeats[idx] - startSeat + keys.length) % keys.length,
    }))
    .sort((a, b) => a.dist - b.dist);

  let tried = 0;
  for (const { key: candidate, seat: candidateSeat } of order) {
    tried++;
    const check = await checkKey(candidate, provider);
    if (check.allowed) {
      // Served → the cursor moves one seat past this key. This is
      // the ONLY place the rotation advances.
      advanceCursor(provider.id, candidateSeat, keys.length);
      return {
        key: { id: candidate.id, label: candidate.label, keyValue: candidate.keyValue },
        check,
        reason: "ok",
        tried,
        seat: candidateSeat,
      };
    }
  }

  return { key: null, check: null, reason: "exhausted", tried, seat: null };
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

/** Switch rule: set selected provider active, all others false.
 *  A newly activated pool starts its rotation cycle from seat 0. */
export async function switchProvider(providerId: string) {
  const target = await db.provider.findUnique({ where: { id: providerId } });
  if (!target) throw new Error("Provider not found");
  await db.$transaction([
    db.provider.updateMany({ data: { isActive: false } }),
    db.provider.update({
      where: { id: providerId },
      data: { isActive: true, rotationCursor: 0 },
    }),
  ]);
  cursorCache.delete(providerId);
  return target;
}
