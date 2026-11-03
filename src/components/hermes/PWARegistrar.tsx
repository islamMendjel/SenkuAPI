"use client";

// Hermes — PWA registrar (Run 27).
//
// One quiet client component that wires the app into the platform:
//   • registers /sw.js on window load (service worker — the piece
//     Chrome requires before it will ever offer "Install App");
//   • stashes the `beforeinstallprompt` event in the store so the
//     sidebar profile menu can offer a one-click "Install App";
//   • tracks installed state — `appinstalled` clears the stashed
//     prompt and `display-mode: standalone` / iOS
//     `navigator.standalone` mark the app as already installed, so
//     the menu entry never offers what the platform already did.

import { useEffect } from "react";
import { useHermes } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";

export function PWARegistrar() {
  const { toast } = useToast();

  useEffect(() => {
    const setInstallPrompt = useHermes.getState().setInstallPrompt;
    const setPwaStandalone = useHermes.getState().setPwaStandalone;

    // ── already running installed? (standalone / iOS home-screen) ──
    const mq = window.matchMedia("(display-mode: standalone)");
    const syncStandalone = () =>
      setPwaStandalone(
        mq.matches ||
          // iOS Safari sets navigator.standalone only inside a
          // home-screen web app; TS doesn't know it.
          (window.navigator as Navigator & { standalone?: boolean })
            .standalone === true
      );
    syncStandalone();
    mq.addEventListener?.("change", syncStandalone);

    // ── service worker — on load, exactly once ──
    let swRegister = () => {
      if (!("serviceWorker" in navigator)) return;
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // registration is best-effort: an insecure context or a
        // blocked worker must never break the chat itself
      });
    };
    if (document.readyState === "complete") swRegister();
    else {
      window.addEventListener("load", swRegister, { once: true });
    }

    // ── install prompt plumbing ──
    const onBeforeInstallPrompt = (e: Event) => {
      // Take ownership: Chrome must NOT show its own mini-infobar —
      // the profile menu owns the install UX.
      e.preventDefault();
      setInstallPrompt(e as Parameters<typeof setInstallPrompt>[0]);
    };
    const onInstalled = () => {
      setInstallPrompt(null);
      setPwaStandalone(true);
      toast({ description: "Hermes was installed. See you on the home screen." });
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      mq.removeEventListener?.("change", syncStandalone);
      window.removeEventListener("load", swRegister);
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [toast]);

  return null;
}
