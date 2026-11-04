"use client";

// Hermes — branded launch splash (Run 27).
//
// SSR-renders at full opacity, so the very first paint of a cold
// launch (installed standalone, or a hard reload) is the brand —
// never a white/blank flash. It fades the moment the app is actually
// alive: `booted` means hydration + the bootstrap round-trip (user,
// providers, chats) have landed. A 4s failsafe guarantees no user is
// ever trapped behind it if the network hangs.

import { useEffect, useState } from "react";
import { useHermes } from "@/lib/store";

export function HermesSplash() {
  const booted = useHermes((s) => s.booted);
  // fading → opacity-0 (the 300ms fade); gone → unmounted entirely
  const [fading, setFading] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (fading) {
      const t = window.setTimeout(() => setGone(true), 320);
      return () => window.clearTimeout(t);
    }
  }, [fading]);

  useEffect(() => {
    if (booted) {
      // one frame so the transition property is committed before the
      // opacity flips — guarantees the fade actually plays
      const raf = requestAnimationFrame(() => setFading(true));
      return () => cancelAnimationFrame(raf);
    }
    // failsafe: network hung → release the splash anyway
    const bail = window.setTimeout(() => setFading(true), 4000);
    return () => window.clearTimeout(bail);
  }, [booted]);

  if (gone) return null;

  return (
    <div
      role="presentation"
      aria-hidden
      className={`fixed inset-0 z-[90] flex flex-col items-center justify-center gap-5 bg-[#0d0d0d] transition-opacity duration-300 motion-reduce:transition-none ${
        fading ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
    >
      {/* Senku logo with gentle breathing pulse */}
      <img
        src="/senku-sparkle.png"
        alt="Senku"
        className="hermes-pulse h-20 w-20 select-none object-contain object-center drop-shadow-[0_0_24px_rgba(251,191,36,0.35)]"
        draggable={false}
      />
      <div className="flex flex-col items-center">
        <p className="text-[14px] font-semibold tracking-[0.25em] text-white">
          SENKU
        </p>
      </div>
    </div>
  );
}
