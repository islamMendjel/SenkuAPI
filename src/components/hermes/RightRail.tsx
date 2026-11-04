"use client";

// Hermes — right engine rail. Run 26: every button is REAL. The
// template-era stubs (Pinned · Video · Billing · Library · Music ·
// "Add tool" — each was just a "coming soon" toast) are gone; the
// rail is now one-tap access to the surfaces that actually exist:
// the Hermes Canvas (sandboxed code preview), the image Gallery,
// the live Usage meter, and the provider Keys behind the gateway.
// Desktop-only (lg+) — mobile reaches all of these via the sidebar.

import { Gauge, Images, KeyRound, PanelRight } from "lucide-react";
import { useHermes } from "@/lib/store";

export function RightRail({
  onOpenProviders,
  onOpenLimiter,
}: {
  onOpenProviders: () => void;
  onOpenLimiter: () => void;
}) {
  const canvasOpen = useHermes((s) => s.canvasOpen);
  const setCanvasOpen = useHermes((s) => s.setCanvasOpen);
  const hasSource = useHermes((s) => s.canvasSource != null);
  const galleryOpen = useHermes((s) => s.galleryOpen);
  const openGallery = useHermes((s) => s.openGallery);
  const closeGallery = useHermes((s) => s.closeGallery);
  const imageCount = useHermes((s) => s.imageCount);

  return (
    <aside
      className="hidden w-12 shrink-0 flex-col items-center gap-1 border-l border-zinc-800/60 py-3 lg:flex"
      aria-label="Engine rail"
    >
      {/* Hermes Canvas — sandboxed preview for html / svg / mermaid /
          js / python blocks surfaced from any conversation. */}
      <button
        title={
          hasSource
            ? "Senku Canvas — sandboxed code preview"
            : "Senku Canvas — opens when you preview a code block"
        }
        aria-label="Toggle Senku Canvas"
        aria-pressed={canvasOpen}
        onClick={() => setCanvasOpen(!canvasOpen)}
        className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
          canvasOpen
            ? "bg-amber-300/15 text-amber-200"
            : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
        }`}
      >
        <PanelRight className="h-4 w-4" />
      </button>

      <div className="my-1 h-px w-6 bg-zinc-800" aria-hidden />

      {/* Image Gallery — every forged image, from every saved chat.
          The corner badge is the honest disk-verified count. */}
      <button
        onClick={() => (galleryOpen ? closeGallery() : openGallery())}
        aria-label="Image gallery"
        aria-pressed={galleryOpen}
        title={
          galleryOpen
            ? "Image Gallery — open (the timeline shows every forged image)"
            : "Image Gallery — every image you have forged, across all chats"
        }
        className={`relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
          galleryOpen
            ? "bg-amber-300/15 text-amber-200"
            : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
        }`}
      >
        <Images className="h-4 w-4" />
        {imageCount > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-zinc-800 bg-[#1d1d20] px-0.5 text-[8.5px] font-semibold tabular-nums text-zinc-300"
            title={`${imageCount} forged image${imageCount === 1 ? "" : "s"} across all chats`}
          >
            {imageCount > 99 ? "99+" : imageCount}
          </span>
        )}
      </button>

      {/* Usage — the live token limiter: today · this month ·
          all-time, with the active pool's metering explained. */}
      <button
        onClick={onOpenLimiter}
        aria-label="Token usage"
        title="Usage — today · this month · all-time, live metering"
        className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
      >
        <Gauge className="h-4 w-4" />
      </button>

      {/* Provider keys — the pools behind the gateway. Bottom anchor,
          where Settings used to live (this IS the settings surface). */}
      <button
        onClick={onOpenProviders}
        aria-label="Provider keys"
        title="Provider keys — manage the pools behind the gateway"
        className="mt-auto flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
      >
        <KeyRound className="h-4 w-4" />
      </button>
    </aside>
  );
}
