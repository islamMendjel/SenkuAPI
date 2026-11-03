"use client";

// Hermes — Run 19: one rAF ease-out count-up. Used by the welcome
// screen's live stat strip so the gateway's real numbers arrive with
// a heartbeat instead of a dead static string.
//
// Honesty rules: returns `null` until armed (callers render nothing
// rather than a made-up 0); on later target changes it re-sweeps FROM
// the settled value (never jumps, never re-runs from zero); and
// prefers-reduced-motion skips straight to the target.
//
// React 19 note: every setState happens inside a requestAnimationFrame
// callback — the effect only synchronizes with the rAF loop (the
// external system), it never flushes state synchronously.

import { useEffect, useRef, useState } from "react";

export function useCountUp(
  target: number | null,
  durationMs = 900
): number | null {
  const [value, setValue] = useState<number | null>(null);
  const settled = useRef(0);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);

    if (target === null || !Number.isFinite(target)) {
      raf.current = requestAnimationFrame(() => setValue(null));
      return;
    }

    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const from = settled.current;

    const tick = (t0: number, t: number) => {
      const p = Math.min(1, (t - t0) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      const v = Math.round(from + (target - from) * eased);
      setValue(v);
      if (p < 1) {
        raf.current = requestAnimationFrame(tick.bind(null, t0));
      } else {
        settled.current = target;
      }
    };

    raf.current = requestAnimationFrame((t) => {
      if (reduced) {
        settled.current = target;
        setValue(target);
        return;
      }
      tick(t, t);
    });

    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      settled.current = target; // unmount mid-sweep: hold the truth
    };
  }, [target, durationMs]);

  return value;
}
