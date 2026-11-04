// Hermes — pooled key router (Run 35: THE ORRERY · Run 42: THE FAIR RING).
// Round-robin rotation operates STRICTLY on the ACTIVE provider's
// keys. The rotation is a PERSISTENT, KEY-ANCHORED cursor:
//
//   • The cursor points at the key that serves NEXT — stored as a
//     KEY ID (Provider.cursorKeyId) with the seat index kept in sync
//     (Provider.rotationCursor) for display and as a legacy fallback.
//     It lives in SQLite, so it survives restarts and redeploys
//     instead of resetting to seat 0 and hammering the first key
//     after every boot. And because the anchor is the KEY itself, a
//     pool mutation (add / remove / toggle) can never silently
//     re-point the rotation at a different key the way a positional
//     index would.
//   • It advances by EXACTLY ONE seat past each key it hands out
//     (limiter-allowed) — never per candidate inspection — so the
//     ring is perfectly even regardless of quarantine skips,
//     limiter blocks or in-turn retries. A key that fails at the
//     STREAM level after being handed out is thereby scanned past on
//     the next turn too — dead keys never pin the rotation, and the
//     health breaker soon quarantines them so they are skipped free.
//   • A turn that serves NOTHING leaves the cursor untouched: the
//     next request retries from the same seat (starvation-free).
//   • Exhausted keys (limiter) and quarantined keys (circuit
//     breaker) are scanned PAST, not onto: the cursor only ever
//     lands on a key that actually served. When every remaining
//     key is quarantined, the least-bad option is still to probe
//     one (it may have recovered) — the breaker simply re-trips if
//     the key is still dead.
//   • Run 42 — DRIFT REPAIR: one request per seat is fair in COUNT,
//     but the monthly pool is billed in TOKENS. A run of heavy
//     prompts can push one key's month-to-date spend far ahead —
//     it caps out mid-month while its neighbors still hold budget
//     the pool never uses. When the ready pool's spend spread
//     exceeds BALANCE_DRIFT_THRESHOLD, the scan STARTS at the
//     least-spent ready key instead of the raw cursor: a bounded
//     negative-feedback controller that evens spend, then hands
//     control back to strict round-robin (spread ≤ threshold ⇒
//     byte-identical legacy behavior). Cursor still advances one
//     seat past whoever served — the ring never skips or stalls.
//   • switchProvider resets the cursor: a fresh cycle on a freshly
//     activated pool.

import { db } from "@/lib/db";
import { isKeyCooling } from "./keyhealth";
import { keyWindowUsage, checkKey, type KeyCheck } from "./limiter";
import { notePick } from "./ring";
import type { RehearsalStep, RehearsalVisit } from "./types";

// Spend spread above which the ring actively rebalances (12%).
// Below it, strict round-robin's natural variance is left alone.
const BALANCE_DRIFT_THRESHOLD = 0.12;

// Write-behind cache of the cursor state {seat, keyId}. Read-through
// on first pick after boot (or after a provider switch); every
// advance updates the cache synchronously and persists to SQLite
// fire-and-forget. Single-process personal gateway: coherent.
interface CursorState {
  seat: number;
  keyId: string | null;
}
const cursorCache = new Map<string, CursorState>();

// ── Run 41: the pick lock — atomic seat reservation ──────────
// The pick critical section (read cursor → scan → advance) must be
// ATOMIC per provider: concurrent stream starts (chat + bridge +
// agent at once) previously could all read the same cursor and
// double-serve the same seat, warping the ring exactly when
// traffic is heaviest. A promise-chain mutex serializes picks:
// each waiter chains onto the previous one's completion, so every
// request reserves a DISTINCT seat, whatever the concurrency.
const pickLocks = new Map<string, Promise<unknown>>();

function withPickLock<T>(
  providerId: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = pickLocks.get(providerId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // The lock tracks settlement, not success — a failed pick never
  // wedges the ring for everyone behind it.
  pickLocks.set(providerId, next.catch(() => undefined));
  return next;
}

/** Cursor state for a provider — cache first, DB on miss. */
async function readCursor(providerId: string): Promise<CursorState> {
  const cached = cursorCache.get(providerId);
  if (cached) return cached;
  const row = await db.provider.findUnique({
    where: { id: providerId },
    select: { rotationCursor: true, cursorKeyId: true },
  });
  const state: CursorState = {
    seat: row?.rotationCursor ?? 0,
    keyId: row?.cursorKeyId ?? null,
  };
  cursorCache.set(providerId, state);
  return state;
}

/** Advance the cursor after a successful serve (one seat past the
 *  key that just served). The KEY-ANCHOR is the id of the key at
 *  the next seat — mutation-proof; the seat index rides along for
 *  display and legacy fallback. Synchronous cache, async DB.
 *  `persist=false` (Run 43 rehearsal) advances ONLY the in-memory
 *  cache — the dry run walks the ring turn by turn without ever
 *  committing a phantom position to SQLite. */
function advanceCursor(
  providerId: string,
  servedSeat: number,
  ring: { id: string }[],
  persist = true
): void {
  const ringSize = ring.length;
  const nextSeat = ringSize > 0 ? (servedSeat + 1) % ringSize : 0;
  const state: CursorState = {
    seat: nextSeat,
    keyId: ringSize > 0 ? (ring[nextSeat]?.id ?? null) : null,
  };
  cursorCache.set(providerId, state);
  if (!persist) return;
  void db.provider
    .update({
      where: { id: providerId },
      data: { rotationCursor: state.seat, cursorKeyId: state.keyId },
    })
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
  /** Run 41 — true when the returned key is a LAST RESORT: every
   *  not-yet-tried key is breaker-quarantined and this one was
   *  handed out only because the ring refuses to run dry while a
   *  probe might still recover it. Dispatchers use this to stop
   * grinding through the whole dead pool when the failure is
   * deterministic (auth / check-in) — one probe is the contract. */
  lastResort?: boolean;
  /** Run 42 — true when drift repair steered this pick (scan
   *  started at the least-spent ready key, not the raw cursor). */
  balanced?: boolean;
  /** Month-to-date spend spread across the ready pool (0..1). */
  drift?: number;
  /** Run 43 — the full scan trace of this pick (simulate mode only):
   *  every candidate visited in ring order with its verdict, so the
   *  rehearsal can replay WHY each seat was passed over. */
  walk?: RehearsalVisit[];
}

export interface PickOptions {
  /** Run 43 — dry run: walk the real pick logic without mutating
   *  anything the live ring can see. The cursor advances only in
   *  the in-memory rehearsal sandbox (restored by rehearseRing),
   *  the DB never learns of it, and the ring ledger stays
   *  real-traffic-only (no notePick). */
  simulate?: boolean;
}

/**
 * Pick the next key via the persistent round-robin cursor over the
 * provider's ACTIVE keys, starting the scan AT the cursor seat and
 * walking the ring forward:
 *   cursor seat → cursor+1 → … wrapping → cursor-1.
 * When spend drift exceeds the threshold, the scan starts at the
 * LEAST-SPENT ready key instead (drift repair, see docblock).
 * Keys blocked by any tier of the pacing limiter are skipped; keys
 * quarantined by the health circuit breaker are skipped when
 * alternatives exist.
 *
 * The whole pick runs under the per-provider pick lock (Run 41):
 * concurrent callers serialize, each reserving a distinct seat.
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
  excludeIds?: ReadonlySet<string>,
  opts?: PickOptions
): Promise<PickResult> {
  return withPickLock(provider.id, () =>
    pickKeyLocked(provider, excludeIds, opts?.simulate ?? false)
  );
}

async function pickKeyLocked(
  provider: {
    id: string;
    name: string;
    hasTokenLimit: boolean;
    tokenLimitPerKey: number;
    rotationCursor?: number;
  },
  excludeIds?: ReadonlySet<string>,
  simulate = false
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
  if (provider.rotationCursor !== undefined && !cursorCache.has(provider.id)) {
    cursorCache.set(provider.id, {
      seat: provider.rotationCursor,
      keyId: null,
    });
  }

  const fresh = excludeIds?.size
    ? keys.filter((k) => !excludeIds.has(k.id))
    : keys;

  if (fresh.length === 0) {
    return { key: null, check: null, reason: "all-tried", tried: keys.length, seat: null };
  }

  // Prefer keys that are not cooling down; if ALL fresh keys are
  // quarantined, probe them anyway (last resort, see docblock) —
  // flagged so the dispatchers can enforce "one deterministic
  // probe", not a grind through every dead seat (Run 41).
  const ready = fresh.filter((k) => !isKeyCooling(k.id));
  const lastResort = ready.length === 0;
  const pool = ready.length ? ready : fresh;
  // Fresh keys are a subsequence of the canonical ring — precompute
  // each pool member's SEAT so the cursor lands on true ring
  // positions even while skipping.
  const seatOf = new Map<string, number>(
    keys.map((k, i) => [k.id, i] as const)
  );
  const poolSeats = pool.map((k) => seatOf.get(k.id) ?? 0);

  // ── Start seat: anchor, then drift repair ────────────────────
  const cursor = await readCursor(provider.id);
  // Key anchor first (mutation-proof); fall back to the positional
  // cursor (legacy rows / anchor key removed or toggled off), then 0.
  let startSeat = cursor.keyId
    ? (seatOf.get(cursor.keyId) ??
      (((cursor.seat % keys.length) + keys.length) % keys.length))
    : (((cursor.seat % keys.length) + keys.length) % keys.length);

  // Run 42 — THE FAIR RING: spend-balanced drift repair. Only for
  // token-limited providers (an unlimited tier has nothing to
  // even out), only with 2+ ready keys, and only when the spread
  // actually matters. The least-spent ready key becomes the scan
  // start; the walk below still applies every limiter check in
  // ring order from there.
  let balanced = false;
  let drift = 0;
  if (provider.hasTokenLimit && ready.length >= 2) {
    const spends = await Promise.all(
      ready.map(async (k) => ({
        id: k.id,
        monthly: (await keyWindowUsage(k.id)).monthly,
      }))
    );
    const max = Math.max(...spends.map((s) => s.monthly));
    const min = Math.min(...spends.map((s) => s.monthly));
    drift = max > 0 ? (max - min) / max : 0;
    if (max > 0 && drift > BALANCE_DRIFT_THRESHOLD) {
      const minEntry = spends.find((s) => s.monthly === min);
      const minSeat = minEntry ? seatOf.get(minEntry.id) : undefined;
      if (minSeat !== undefined) {
        startSeat = minSeat;
        balanced = true;
      }
    }
  }

  // Visit order: pool members sorted by ring distance from the
  // (possibly rebalanced) start seat — the natural "walk the ring
  // forward".
  const order = pool
    .map((k, idx) => ({
      key: k,
      seat: poolSeats[idx],
      dist: (poolSeats[idx] - startSeat + keys.length) % keys.length,
    }))
    .sort((a, b) => a.dist - b.dist);

  let tried = 0;
  const walk: RehearsalVisit[] = [];
  for (const { key: candidate, seat: candidateSeat } of order) {
    tried++;
    const check = await checkKey(candidate, provider);
    // Run 43 — record the visit either way: the rehearsal replays
    // the whole scan, skips included, so "why didn't seat 3 serve?"
    // has a visible answer (cooling / capped tier).
    walk.push({
      seat: candidateSeat,
      keyId: candidate.id,
      label: candidate.label,
      allowed: check.allowed,
      blockedTier: check.blockedTier,
      cooling: isKeyCooling(candidate.id),
    });
    if (check.allowed) {
      // Served → the cursor moves one seat past this key. This is
      // the ONLY place the rotation advances. Simulate mode advances
      // the cache only — SQLite never hears about a dry run.
      advanceCursor(provider.id, candidateSeat, keys, !simulate);
      // Run 42 — reserve the seat for the ring ledger: when this
      // key's success is confirmed (noteKeySuccess), the serve is
      // recorded with its seat and label. The rehearsal NEVER
      // reserves — the ledger is real traffic's story alone.
      if (!simulate) notePick(candidate.id, candidateSeat, candidate.label);
      return {
        key: { id: candidate.id, label: candidate.label, keyValue: candidate.keyValue },
        check,
        reason: "ok",
        tried,
        seat: candidateSeat,
        ...(lastResort ? { lastResort: true } : {}),
        ...(balanced ? { balanced: true } : {}),
        ...(drift > 0 ? { drift } : {}),
        ...(simulate ? { walk } : {}),
      };
    }
  }

  return {
    key: null,
    check: null,
    reason: "exhausted",
    tried,
    seat: null,
    ...(simulate ? { walk } : {}),
  };
}

// ── Run 43: THE RING REHEARSAL ─────────────────────────────────
// Dry-run the rotation N turns into the future using the REAL pick
// logic — the same breaker skips, pacing-tier skips, drift-repair
// bias and key-anchored cursor the gateway dispatches with — while
// mutating nothing the live ring can see:
//   • Runs under the pick lock, so real traffic cannot interleave
//     (a real pick mid-rehearsal would consume a seat the restore
//     would then erase).
//   • The cursor advances between turns in the in-memory cache only
//     (advanceCursor persist=false); SQLite is never written.
//   • When the walk ends, the exact pre-rehearsal cursor state is
//     put back — the next REAL request serves exactly what it would
//     have served had the rehearsal never happened.
//   • notePick is never called: the ring ledger records confirmed
//     serves, and a rehearsal serves nothing.
// The result is both a fairness PROOF ("10 turns → 3/3/4 spread")
// and a debugging oracle (per-seat skip reasons). Safe by design:
// worst case, a caller watches numbers move in a dialog.
export interface RehearsalResult {
  steps: RehearsalStep[];
  /** True when drift repair steered at least one rehearsed turn. */
  balanced: boolean;
  /** Largest spend spread observed across the rehearsed turns. */
  drift: number;
  /** Seat the first rehearsed turn started from (cursor anchor). */
  startSeat: number;
}

export async function rehearseRing(
  providerId: string,
  turns = 10
): Promise<RehearsalResult> {
  return withPickLock(providerId, async () => {
    const provider = await db.provider.findUnique({ where: { id: providerId } });
    if (!provider) throw new Error("Provider not found");
    const keys = await db.apiKey.findMany({
      where: { providerId, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    const seatOf = new Map<string, number>(keys.map((k, i) => [k.id, i]));
    const mod = (n: number) =>
      keys.length ? ((n % keys.length) + keys.length) % keys.length : 0;

    // Snapshot the pre-rehearsal cursor (primes the cache on a cold
    // boot exactly like a real pick would).
    const snapshot = await readCursor(providerId);
    const startSeat = snapshot.keyId
      ? (seatOf.get(snapshot.keyId) ?? mod(snapshot.seat))
      : mod(snapshot.seat);

    const n = Math.max(1, Math.min(20, Math.floor(turns) || 10));
    const steps: RehearsalStep[] = [];
    let balanced = false;
    let drift = 0;
    for (let turn = 1; turn <= n; turn++) {
      const r = await pickKeyLocked(provider, undefined, true);
      if (r.balanced) balanced = true;
      if (typeof r.drift === "number" && r.drift > drift) drift = r.drift;
      steps.push({
        turn,
        served: r.key
          ? { seat: r.seat ?? 0, keyId: r.key.id, label: r.key.label }
          : null,
        walk: r.walk ?? [],
        reason: r.reason,
      });
      // A turn that serves nothing would replay the identical stall
      // every turn after — the walk trace of THIS turn already shows
      // every blocked seat and why. Say it once, honestly.
      if (r.reason !== "ok") break;
    }

    // As if it never happened.
    cursorCache.set(providerId, snapshot);
    return { steps, balanced, drift, startSeat };
  });
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
      data: { isActive: true, rotationCursor: 0, cursorKeyId: null },
    }),
  ]);
  cursorCache.delete(providerId);
  return target;
}
