// Hermes — THE RING LEDGER (Run 42).
// The ring used to be invisible in motion: the Orrery showed the
// "next" seat but never the last serves, so the rotation's only
// proof was the fairness percentage. The ledger gives the ring a
// HEARTBEAT — every pooled serve is recorded (key, seat, tokens,
// model, when) and the UI replays the freshest few under the ring.
//
// Recording point: noteKeySuccess — the ONE moment every serve path
// (chat pipeline, /v1 OpenAI bridge, Anthropic bridge, agent) already
// funnels through. The pick registry below maps the served key back
// to its seat + label at handout time, so callers never carry ring
// plumbing — they just report success with the token bill they
// already hold.
//
// In-memory by design (single-process personal gateway, consistent
// with the breaker and the serve ledger): a restart simply restarts
// the story. Maps live on globalThis because Next dev evaluates this
// module in more than one module registry — the prober, the router
// and the dispatchers MUST share one ledger.

export interface RingEvent {
  keyId: string;
  label: string;
  seat: number;
  tokens: number;
  model: string;
  at: string; // ISO instant of the serve
}

const MAX_EVENTS = 12;
const REGISTRY_TTL_MS = 30 * 60_000; // a handout unconfirmed after 30 min is stale

const pickRegistry = ((
  globalThis as {
    __hermesPickRegistry?: Map<string, { seat: number; label: string; at: number }>;
  }
).__hermesPickRegistry ??= new Map());

const events = ((globalThis as { __hermesRingEvents?: RingEvent[] })
  .__hermesRingEvents ??= []);

function pruneRegistry(now = Date.now()): void {
  for (const [id, pick] of pickRegistry) {
    if (now - pick.at > REGISTRY_TTL_MS) pickRegistry.delete(id);
  }
}

/** The router calls this at handout time — the seat is reserved for
 *  this key's next confirmed success. */
export function notePick(keyId: string, seat: number, label: string): void {
  pickRegistry.set(keyId, { seat, label, at: Date.now() });
  if (pickRegistry.size > 64) pruneRegistry();
}

/** A serve confirmed: pin the event (seat/label from the registry)
 *  and drop the reservation — one event per handout, never double-
 *  counted by retries or probe successes. */
export function recordRingEvent(
  keyId: string,
  tokens: number,
  model: string
): void {
  const pick = pickRegistry.get(keyId);
  if (!pick) return; // probe success / unknown handout — not a serve
  pickRegistry.delete(keyId);
  events.unshift({
    keyId,
    label: pick.label,
    seat: pick.seat,
    tokens,
    model,
    at: new Date().toISOString(),
  });
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
}

/** Freshest serves first, newest at index 0. Read-only copy. */
export function recentRingEvents(): RingEvent[] {
  return [...events];
}
