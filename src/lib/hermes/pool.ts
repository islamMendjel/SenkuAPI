// Hermes — THE LIVING POOL (Run 41): background key prober.
//
// The breaker only learns a key died when a real client request
// hits it — a dead key eats one failed round-trip per cooldown
// expiry, and a HEALED key (the owner completed the daily check-in)
// is only rediscovered by another failing client request. Both are
// client-visible failures the pool can absorb for free.
//
// The prober closes that gap from both directions:
//   • DEAD → it probes unproven / cooldown-expired keys in the
//     background and breaker-marks them under the right failure
//     kind (402 → "check-in", 401/403 → "auth") BEFORE any client
//     pays for the discovery.
//   • HEALED → the moment a probe succeeds, the key re-enters the
//     ring (noteKeySuccess) — zero client-visible failures, no
//     waiting for traffic.
//
// Discipline (the prober is additive, never authoritarian):
//   • It NEVER quarantines a currently-healthy key — real traffic
//     remains the breaker's only judge there. A failed probe on a
//     live key is recorded as telemetry, nothing more.
//   • It probes with max_tokens: 1 — the cheapest possible liveness
//     question — and skips keys the breaker currently holds (they
//     are re-probed naturally when their cooldown expires).
//   • Healthy keys get a keep-alive probe every 10 minutes so the
//     UI's live state stays honest even without traffic.
//
// Single-process personal gateway: state is in-memory and the
// interval is a globalThis-guarded singleton (dev hot-reloads and
// repeated register() calls can never stack probes).

import { db } from "@/lib/db";
import {
  keyHealthSnapshot,
  noteKeyFailure,
  noteKeySuccess,
  servedThisBoot,
} from "./keyhealth";

export type PoolKeyState =
  | "serving" // probe-verified live, not quarantined
  | "unproven" // active but neither served nor probe-verified this boot
  | "cooling" // breaker cooldown (auth / transient kinds)
  | "checkin" // 402 — daily dashboard check-in required
  | "down"; // last probe failed on a non-402 status

export interface PoolKeyRecord {
  state: PoolKeyState;
  proven: boolean;
  lastProbeAt: Date | null;
  lastLatencyMs: number | null;
  lastProbeStatus: number | null;
  lastError: string | null;
  /** Successful pooled serves this boot (real traffic, not probes). */
  serves: number;
}

const TICK_MS = 30_000;
const HEALTHY_REPROBE_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 12_000;

/** First probe pass fires almost immediately after boot — the
 *  welcome screen's pool truth must never open on a guess. */
const FIRST_TICK_DELAY_MS = 1_500;

let ticking = false;

// The records live on globalThis (Run 41): Next dev evaluates this
// module in more than one module registry — the instrumentation
// hook arms the tick loop, while the route handlers read
// poolKeyRecords() — and they MUST see the same probe truth, or
// the UI would report "unproven" forever while the prober happily
// probes. Hot reloads re-evaluate the module too; the records
// survive with the process, like the breaker's state.
const records = ((globalThis as { __hermesPoolRecords?: Map<string, PoolKeyRecord> })
  .__hermesPoolRecords ??= new Map<string, PoolKeyRecord>());

function recordFor(keyId: string): PoolKeyRecord {
  let r = records.get(keyId);
  if (!r) {
    r = {
      state: "unproven",
      proven: false,
      lastProbeAt: null,
      lastLatencyMs: null,
      lastProbeStatus: null,
      lastError: null,
      serves: 0,
    };
    records.set(keyId, r);
  }
  return r;
}

/** One liveness question: can this key generate one token right now? */
async function probeKey(
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<{ status: number; latencyMs: number; error: string | null }> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Drain the (tiny) body so the socket reuses cleanly.
    await res.text().catch(() => "");
    return { status: res.status, latencyMs: Date.now() - t0, error: null };
  } catch (e) {
    return {
      status: 0,
      latencyMs: Date.now() - t0,
      error: e instanceof Error ? e.message : "probe failed",
    };
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const provider = await db.provider.findFirst({ where: { isActive: true } });
    if (!provider || !provider.baseUrl) return;
    const keys = await db.apiKey.findMany({
      where: { providerId: provider.id, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    if (keys.length === 0) return;

    let models: string[] = [];
    try {
      models = JSON.parse(provider.models || "[]") as string[];
    } catch {
      models = [];
    }
    const model = models[0] ?? "free/glm-5.3";
    const health = keyHealthSnapshot();
    const now = Date.now();
    const serves = servedThisBoot();

    for (const key of keys) {
      const rec = recordFor(key.id);
      const breaker = health[key.id];
      rec.serves = serves[key.id] ?? 0;

      // The breaker currently holds this key: reflect its verdict,
      // skip the probe until the cooldown expires (the re-probe on
      // expiry is the check-in healing path).
      if (breaker) {
        rec.state = breaker.kind === "checkin" ? "checkin" : "cooling";
        continue;
      }

      const probeAge = rec.lastProbeAt ? now - rec.lastProbeAt.getTime() : Infinity;
      const needsProbe =
        !rec.proven || probeAge >= HEALTHY_REPROBE_MS;

      if (!needsProbe) {
        rec.state = "serving";
        continue;
      }

      const result = await probeKey(provider.baseUrl, key.keyValue, model);
      rec.lastProbeAt = new Date();
      rec.lastLatencyMs = result.latencyMs;
      rec.lastProbeStatus = result.status;
      rec.lastError = result.error;

      if (result.status === 200) {
        // Heals a quarantined-but-expired key, proves a fresh one,
        // and confirms a healthy one. Probes never inflate the
        // serve ledger (countServe: false).
        noteKeySuccess(key.id, false);
        rec.proven = true;
        rec.state = "serving";
      } else if (result.status === 402) {
        rec.proven = false;
        rec.state = "checkin";
        // Only quarantine via the breaker when the key was NOT
        // already serving real traffic this instant — a 402 IS
        // account-level truth, so marking is safe even for
        // previously-live keys (the breaker re-probes in 10 min).
        noteKeyFailure(key.id, "checkin");
      } else if (result.status === 401 || result.status === 403) {
        rec.proven = false;
        rec.state = "down";
        noteKeyFailure(key.id, "auth");
      } else {
        // Network error / 5xx / 429 on the PROBE path: telemetry
        // only for a live key (the real traffic is the judge);
        // an unproven key stays unproven and retries next tick.
        rec.state = rec.proven ? "down" : "unproven";
      }
    }
  } catch {
    // The pool prober must never throw into the scheduler loop.
  } finally {
    ticking = false;
  }
}

let started = false;

/** Arm the prober exactly once per process (globalThis-guarded so
 *  dev hot-reloads and repeated register() calls never stack). */
export function startPoolProber(): void {
  const g = globalThis as { __hermesPoolProber?: boolean };
  if (g.__hermesPoolProber || started) return;
  started = true;
  g.__hermesPoolProber = true;
  const first = setTimeout(() => void tick(), FIRST_TICK_DELAY_MS);
  if (typeof first.unref === "function") first.unref();
  const interval = setInterval(() => void tick(), TICK_MS);
  if (typeof interval.unref === "function") interval.unref();
}

/** Read-only view of the prober's own records — the serialize
 *  layer merges it with the breaker snapshot per key. */
export function poolKeyRecords(): Record<string, PoolKeyRecord> {
  return Object.fromEntries(records);
}

// ── Run 42: the self-service probe ───────────────────────────
// The background prober runs on its own 30 s cadence, and a
// quarantined key only re-enters the ring when its cooldown
// expires AND the next probe succeeds. After the owner completes
// a daily check-in (or replaces a rejected key) that is dead time
// they can feel. probeKeyNow runs ONE liveness probe immediately
// — the exact same probe the tick loop uses — so the seat flips
// the moment the fix actually landed. On success it clears the
// breaker state (the key rejoins instantly); on failure it
// re-trips the breaker under the right kind (honest verdict).

export interface ProbeNowResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  error: string | null;
  /** "not-found": key missing or its provider has no base URL;
   *  "inactive": the key is toggled off (nothing to heal). */
  reason?: "not-found" | "inactive";
}

export async function probeKeyNow(keyId: string): Promise<ProbeNowResult> {
  const key = await db.apiKey.findUnique({
    where: { id: keyId },
    include: { provider: true },
  });
  if (!key || !key.provider.baseUrl) {
    return { ok: false, status: 0, latencyMs: 0, error: null, reason: "not-found" };
  }
  if (!key.isActive) {
    return { ok: false, status: 0, latencyMs: 0, error: null, reason: "inactive" };
  }

  let models: string[] = [];
  try {
    models = JSON.parse(key.provider.models || "[]") as string[];
  } catch {
    models = [];
  }
  const model = models[0] ?? "free/glm-5.3";

  const result = await probeKey(key.provider.baseUrl, key.keyValue, model);

  const rec = recordFor(keyId);
  rec.lastProbeAt = new Date();
  rec.lastLatencyMs = result.latencyMs;
  rec.lastProbeStatus = result.status;
  rec.lastError = result.error;

  if (result.status === 200) {
    // Heals a quarantined key instantly (breaker state cleared) —
    // zero waiting for the tick. Probes never inflate the serve
    // ledger (countServe: false) and pass no ring meta.
    noteKeySuccess(keyId, false);
    rec.proven = true;
    rec.state = "serving";
  } else if (result.status === 402) {
    rec.proven = false;
    rec.state = "checkin";
    noteKeyFailure(keyId, "checkin");
  } else if (result.status === 401 || result.status === 403) {
    rec.proven = false;
    rec.state = "down";
    noteKeyFailure(keyId, "auth");
  } else {
    // Transient / 5xx / network on the manual probe: telemetry for
    // a proven key, unproven stays unproven — same rules as the tick.
    rec.state = rec.proven ? "down" : "unproven";
  }

  return {
    ok: result.status === 200,
    status: result.status,
    latencyMs: result.latencyMs,
    error: result.error,
  };
}

/** How many of the given active keys are believed live right now.
 *  Null until every active key has been seen by a tick (boot, or a
 *  key added moments ago) — callers must not claim a number they
 *  do not have. */
export function servingCount(activeKeyIds: string[]): number | null {
  if (activeKeyIds.length === 0) return 0;
  let serving = 0;
  for (const id of activeKeyIds) {
    const r = records.get(id);
    if (!r) return null; // first pass incomplete for the pool
    if (r.state === "serving") serving++;
  }
  return serving;
}
