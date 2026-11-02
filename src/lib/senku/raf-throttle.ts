// SenkuAPI — rAF-gated flush scheduler for streamed content.
//
// Run 17 — every SSE delta used to run a full store `set` (whole
// messages array mapped + React re-render + markdown re-parse of the
// streaming message). Network bursts arrived far faster than any
// human can read, so the render path did needless work per chunk.
//
// Contract (spec: "throttle markdown/UI state updates using
// requestAnimationFrame, ~32 ms minimum interval between normal
// flushes"):
//   • notify()    — signal that new data is pending. Schedules ONE
//                   animation frame; repeated notifies coalesce.
//   • the frame callback enforces the interval with TIMESTAMPS
//                   (performance.now()), not timers: if the last
//                   flush is younger than MIN_INTERVAL_MS the frame
//                   simply reschedules itself on the NEXT frame.
//                   rAF is the scheduler; the timestamp is only the
//                   gate. Background tabs (rAF paused) lose nothing —
//                   flushNow() always runs on stream end.
//   • flushNow()  — synchronous, unconditional final flush (stream
//                   completed / errored / cancelled): the pending
//                   frame is cancelled first so a stale callback can
//                   never fire afterwards.
//   • cancel()    — drop the scheduled frame without flushing (the
//                   caller is about to write an authoritative value
//                   itself, e.g. the server-truth `done` payload).
//
// The flush callback reads the LATEST buffer state at call time (the
// buffer itself always accumulates synchronously — throttling only
// delays the *render*, never the data), so no token can be lost and
// ordering is preserved: flushes always emit a growing prefix.

/** Minimum milliseconds between two normal (non-final) flushes. */
export const STREAM_FLUSH_MIN_INTERVAL_MS = 32;

export class StreamFlushScheduler {
  private rafId: number | null = null;
  private lastFlushAt = 0;
  private pending = false;

  constructor(
    private readonly flush: () => void,
    private readonly minIntervalMs: number = STREAM_FLUSH_MIN_INTERVAL_MS
  ) {}

  /** New data is pending — schedule a frame if none is scheduled. */
  notify(): void {
    if (this.pending) return;
    // No rAF machinery (SSR / ancient env): degrade to a microtask
    // so the flush still happens, just unpaced.
    if (typeof requestAnimationFrame !== "function") {
      this.pending = true;
      queueMicrotask(() => {
        this.pending = false;
        this.lastFlushAt = now();
        this.flush();
      });
      return;
    }
    this.pending = true;
    this.rafId = requestAnimationFrame(this.tick);
  }

  /** Timestamp-gated frame callback. */
  private tick = (t: number): void => {
    this.rafId = null;
    if (!this.pending) return; // cancelled meanwhile
    if (t - this.lastFlushAt >= this.minIntervalMs) {
      this.pending = false;
      this.lastFlushAt = t;
      this.flush();
      return;
    }
    // Too soon after the previous flush — wait for the next frame.
    this.rafId = requestAnimationFrame(this.tick);
  };

  /** Final flush: cancel any scheduled frame, then flush NOW. Used
   *  on stream completion / error / client Stop so the very last
   *  buffered tokens are always displayed exactly once. */
  flushNow(): void {
    this.cancel();
    this.lastFlushAt = now();
    this.flush();
  }

  /** Drop the pending frame WITHOUT flushing (an authoritative
   *  write is about to replace the buffered content). */
  cancel(): void {
    if (this.rafId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
    this.pending = false;
  }
}

function now(): number {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}
