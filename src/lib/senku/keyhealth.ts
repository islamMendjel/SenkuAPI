// SenkuAPI — key health circuit breaker.
// In-memory per-key failure tracking so the pooled router stops
// round-robining into dead keys:
//   • AUTH failure (401/403) → 1 strike = 10-minute quarantine.
//     A rejected credential will not heal itself, but the key is
//     probed again after the cooldown in case it gets rotated.
//   • TRANSIENT failure (network cut, empty stream) → 2 strikes
//     within a 5-minute window = 60-second cooldown.
//   • Any success clears all strikes for that key.
// State is intentionally in-memory (single-process personal gateway,
// consistent with the local-memory caching policy): a restart simply
// re-probes every key once.

export type FailureKind = "auth" | "transient";

const AUTH_COOLDOWN_MS = 10 * 60_000;
const TRANSIENT_STRIKE_WINDOW_MS = 5 * 60_000;
const TRANSIENT_STRIKES_TO_TRIP = 2;
const TRANSIENT_COOLDOWN_MS = 60_000;

interface KeyState {
  strikes: number;
  lastFailAt: number;
  cooldownUntil: number;
}

const states = new Map<string, KeyState>();

/** Record a failed attempt for a key and (maybe) start a cooldown. */
export function noteKeyFailure(keyId: string, kind: FailureKind, now = Date.now()): void {
  const prev = states.get(keyId);

  if (kind === "auth") {
    states.set(keyId, {
      strikes: (prev?.strikes ?? 0) + 1,
      lastFailAt: now,
      cooldownUntil: now + AUTH_COOLDOWN_MS,
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
  });
}

/** A successful call clears every strike and cooldown for the key. */
export function noteKeySuccess(keyId: string): void {
  states.delete(keyId);
}

/** True while the key is quarantined by a cooldown. */
export function isKeyCooling(keyId: string, now = Date.now()): boolean {
  const s = states.get(keyId);
  return s !== undefined && s.cooldownUntil > now;
}
