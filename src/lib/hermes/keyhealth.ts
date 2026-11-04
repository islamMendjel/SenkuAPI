// Hermes — key health circuit breaker.
// In-memory per-key failure tracking so the pooled router stops
// round-robining into dead keys:
//   • AUTH failure (401/403) → 1 strike = 10-minute quarantine.
//     A rejected credential will not heal itself, but the key is
//     probed again after the cooldown in case it gets rotated.
//   • CHECK-IN failure (402 billing_error — Run 41) → 1 strike =
//     10-minute quarantine. A key demanding a daily dashboard
//     check-in will not heal by being retried; it cools like an
//     auth failure and is re-probed at cooldown expiry (by the
//     background prober — never by a real client request).
//   • TRANSIENT failure (network cut, empty stream) → 2 strikes
//     within a 5-minute window = 60-second cooldown.
//   • Any success clears all strikes for that key.
// State is intentionally in-memory (single-process personal gateway,
// consistent with the local-memory caching policy): a restart simply
// re-probes every key once. The maps live on globalThis because Next
// dev can evaluate this module in MORE THAN ONE module registry
// (the instrumentation hook vs the route handlers) and hot reloads
// re-evaluate it — the breaker's truth must be ONE map per process
// either way, or the prober and the router would disagree about
// which keys are quarantined (Run 41).

export type FailureKind = "auth" | "transient" | "checkin";

const AUTH_COOLDOWN_MS = 10 * 60_000;
const CHECKIN_COOLDOWN_MS = 10 * 60_000;
const TRANSIENT_STRIKE_WINDOW_MS = 5 * 60_000;
const TRANSIENT_STRIKES_TO_TRIP = 2;
const TRANSIENT_COOLDOWN_MS = 60_000;

interface KeyState {
  strikes: number;
  lastFailAt: number;
  cooldownUntil: number;
  /** The failure kind that produced the CURRENT cooldown — the UI
   *  speaks it ("needs check-in" vs "cooling down"). */
  kind?: FailureKind;
}

const states = ((globalThis as { __hermesKeyStates?: Map<string, KeyState> })
  .__hermesKeyStates ??= new Map<string, KeyState>());

// ── Run 41: per-boot serve ledger ────────────────────────────
// Every POOLED success (chat pipeline + both /v1 bridges confirm
// through noteKeySuccess) ticks this counter. It is the honest
// "who actually served" evidence the UI and the fairness readout
// display — in-memory by design, scoped to this process boot
// (globalThis so every module registry reads the same ledger).
const serveCounts = ((globalThis as { __hermesServeCounts?: Map<string, number> })
  .__hermesServeCounts ??= new Map<string, number>());

function bumpServe(keyId: string): void {
  serveCounts.set(keyId, (serveCounts.get(keyId) ?? 0) + 1);
}

/** Per-boot serve counts, keyed by key id (only keys that served). */
export function servedThisBoot(): Record<string, number> {
  return Object.fromEntries(serveCounts);
}

/** Record a failed attempt for a key and (maybe) start a cooldown. */
export function noteKeyFailure(
  keyId: string,
  kind: FailureKind,
  now = Date.now()
): void {
  const prev = states.get(keyId);

  if (kind === "auth" || kind === "checkin") {
    states.set(keyId, {
      strikes: (prev?.strikes ?? 0) + 1,
      lastFailAt: now,
      cooldownUntil: now + (kind === "auth" ? AUTH_COOLDOWN_MS : CHECKIN_COOLDOWN_MS),
      kind,
    });
    return;
  }

  // Transient: strikes only accumulate inside the strike window.
  const inWindow =
    prev !== undefined && now - prev.lastFailAt <= TRANSIENT_STRIKE_WINDOW_MS;
  const strikes = inWindow ? prev.strikes + 1 : 1;
  states.set(keyId, {
    strikes,
    lastFailAt: now,
    cooldownUntil:
      strikes >= TRANSIENT_STRIKES_TO_TRIP
        ? now + TRANSIENT_COOLDOWN_MS
        : prev?.cooldownUntil ?? 0,
    kind: "transient",
  });
}

/** A successful call clears every strike and cooldown for the key. */
export function noteKeySuccess(keyId: string, countServe = true): void {
  if (countServe) bumpServe(keyId);
  states.delete(keyId);
}

/** True while the key is quarantined by a cooldown. */
export function isKeyCooling(keyId: string, now = Date.now()): boolean {
  const s = states.get(keyId);
  return s !== undefined && s.cooldownUntil > now;
}

/** Run 35 — THE ORRERY: live breaker state for the UI. Returns the
 *  keys currently quarantined with the instant their cooldown ends
 *  (null once healthy) and WHY they are quarantined. In-memory by
 *  design: it IS the breaker's own state, exported read-only. */
export function keyHealthSnapshot(
  now = Date.now()
): Record<
  string,
  { coolingUntil: string; strikes: number; kind: FailureKind }
> {
  const out: Record<
    string,
    { coolingUntil: string; strikes: number; kind: FailureKind }
  > = {};
  for (const [keyId, s] of states) {
    if (s.cooldownUntil > now) {
      out[keyId] = {
        coolingUntil: new Date(s.cooldownUntil).toISOString(),
        strikes: s.strikes,
        kind: s.kind ?? "transient",
      };
    }
  }
  return out;
}
