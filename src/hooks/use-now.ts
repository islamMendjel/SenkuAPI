"use client";

// Shared live clock (React 19 idiomatic): one interval drives every
// surface that shows "now" — welcome line, composer chip — without
// per-component setState-in-effect (hydration-safe via server snapshot).

import { useSyncExternalStore } from "react";

const TICK_MS = 1000;

let listeners: Set<() => void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function ensureTicking() {
  if (timer) return;
  timer = setInterval(() => {
    listeners?.forEach((l) => l());
  }, TICK_MS);
}

function subscribe(onChange: () => void): () => void {
  ensureTicking();
  listeners = listeners ?? new Set();
  listeners.add(onChange);
  return () => {
    listeners?.delete(onChange);
    if (listeners && listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Whole-second snapshot — stable between ticks (required by uSES). */
function getSnapshot(): number {
  return Math.floor(Date.now() / TICK_MS);
}

/** Server/hydration snapshot: 0 = "clock not mounted yet". */
function getServerSnapshot(): number {
  return 0;
}

/** Current Date, ticking every second (null before mount). */
export function useNow(): Date | null {
  const seconds = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );
  return seconds > 0 ? new Date(seconds * TICK_MS) : null;
}
