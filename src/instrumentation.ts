// Hermes — server instrumentation (Run 34).
// Next.js calls register() exactly once when the server process
// boots (nodejs runtime only) — the natural place to arm the
// Rituals scheduler, which must fire scheduled prompts whether or
// not any browser is connected. The scheduler itself is
// singleton-guarded on globalThis, so repeated registrations (or
// dev hot-reloads) can never stack intervals.
//
// Run 41 — THE LIVING POOL: the key-pool prober arms here too, so
// the ring probes itself from the moment the process exists (not
// on the first client request) — dead keys are known before any
// real turn pays for the discovery, and healed keys rejoin the
// rotation the instant they pass a probe.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startRitualScheduler } = await import("@/lib/hermes/ritual");
  startRitualScheduler();
  const { startPoolProber } = await import("@/lib/hermes/pool");
  startPoolProber();
}
