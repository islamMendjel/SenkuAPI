"use client";

// Hermes — Run 23 THE GALLERY: image history, the way chats have
// history. Every image the forge ever produced — from every saved
// chat, active answers AND re-rolled snapshots — in one masonry,
// newest first. Click any tile for the fullscreen lightbox: full
// provenance (dims · KB · forge seconds · date · birth chat), one
// click Download, arrow-key browsing, and "Open in chat" which lands
// you in the conversation the image was born in. The empty state is
// a conversion hook: one button arms Image mode on a fresh chat.
//
// Honest by construction (same contract as chats history):
//   • temporary chats never write DB rows → never appear here
//   • deleted chats take their images with them (cascade)
//   • a listing only exists while its file exists on disk
//   • the sidebar badge counts exactly what this view lists

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Images,
  MessageSquare,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { useHermes } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import type { GalleryItem } from "@/lib/hermes/types";

/** "2h ago" style — coarse on purpose (the exact date lives in the
 *  lightbox). Client-only, same clock as the live welcome time. */
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "just now";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function fullDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatKB(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function ImageGallery() {
  const {
    newChat,
    selectChat,
    closeGallery,
    streaming,
    imageMode,
    toggleImageMode,
  } = useHermes();
  const { toast } = useToast();

  const [items, setItems] = useState<GalleryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const reloadRef = useRef(0);

  const load = useCallback(async () => {
    const gen = ++reloadRef.current;
    setError(null);
    try {
      const res = await fetch("/api/images");
      const data = (await res.json()) as {
        images?: GalleryItem[];
        error?: string;
      };
      if (gen !== reloadRef.current) return; // a newer reload won
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
      setItems(data.images ?? []);
    } catch (e) {
      if (gen !== reloadRef.current) return;
      setItems([]);
      setError((e as Error).message || "Could not load the gallery.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const chatCount = useMemo(
    () => new Set((items ?? []).map((i) => i.chatId)).size,
    [items]
  );

  // ── Lightbox keyboard: Esc closes, ←/→ walk the collection ──
  useEffect(() => {
    if (zoom === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoom(null);
      else if (e.key === "ArrowLeft")
        setZoom((z) =>
          z === null || items === null || items.length === 0
            ? z
            : (z - 1 + items.length) % items.length
        );
      else if (e.key === "ArrowRight")
        setZoom((z) =>
          z === null || items === null || items.length === 0
            ? z
            : (z + 1) % items.length
        );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom, items]);

  /** Leave the gallery and land in the conversation this image was
   *  born in. A stream in flight keeps its chat (selectChat guards),
   *  but the view still returns so nothing feels stuck. */
  const openInChat = (chatId: string) => {
    setZoom(null);
    closeGallery();
    if (!streaming) void selectChat(chatId);
  };

  /** Empty-state CTA: fresh chat + Image mode armed — the composer's
   *  amber state takes it from there (conversion, not a detour). */
  const startForging = () => {
    newChat(); // also closes the gallery (store)
    if (!imageMode) toggleImageMode();
    toast({
      description: "Image mode armed — describe the image to forge.",
    });
  };

  const active =
    zoom !== null && items !== null && items[zoom] ? items[zoom] : null;

  return (
    <section
      aria-label="Image gallery"
      className="hermes-fade-up relative flex min-h-0 flex-1 flex-col"
    >
      {/* aurora backdrop — same visual language as the welcome */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        <div className="hermes-aurora absolute left-[4%] top-[6%] h-72 w-72 rounded-full bg-amber-500/[0.06] blur-3xl" />
        <div className="hermes-aurora-b absolute right-[2%] top-[30%] h-80 w-80 rounded-full bg-emerald-500/[0.05] blur-3xl" />
      </div>

      {/* header */}
      <header className="flex items-center gap-3 px-4 pb-3 pt-5 sm:px-6">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-300/20 bg-amber-400/10">
          <Images className="h-5 w-5 text-amber-300" aria-hidden />
        </span>
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold tracking-tight text-white">
            Image Gallery
          </h1>
          <p className="truncate text-[12px] text-zinc-500">
            {items === null
              ? "Every image the forge ever made…"
              : items.length === 0
                ? "Every image the forge ever makes will live here"
                : `${items.length} image${items.length === 1 ? "" : "s"} · ${chatCount} chat${chatCount === 1 ? "" : "s"}`}
            {/* "newest first" is desktop-only breathing room — the
                390px header stays clean (one short line, no squeeze). */}
            {items !== null &&
              items.length > 0 &&
              (items.length > 1 || chatCount > 1) && (
                <span className="hidden sm:inline"> · newest first</span>
              )}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {items !== null && (
            <button
              type="button"
              onClick={() => void load()}
              aria-label="Refresh the gallery"
              title="Refresh"
              className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={closeGallery}
            aria-label="Close the gallery"
            title="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* body */}
      <div className="hermes-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-10 sm:px-6">
        {/* loading — shimmering masonry skeletons */}
        {items === null && !error && (
          <div className="columns-2 gap-3 sm:columns-3 lg:columns-4 2xl:columns-5 [column-fill:balance]">
            {Array.from({ length: 10 }).map((_, i) => (
              <div
                key={i}
                className="mb-3 break-inside-avoid overflow-hidden rounded-xl border border-zinc-800 bg-[#1d1d20]"
                style={{ aspectRatio: i % 3 === 0 ? "3 / 4" : "1 / 1" }}
              >
                <div className="h-full w-full animate-pulse bg-zinc-800/50" />
              </div>
            ))}
          </div>
        )}

        {/* error — honest, retryable */}
        {error && (
          <div className="mx-auto mt-16 flex max-w-sm flex-col items-center text-center">
            <p className="text-[14px] font-medium text-zinc-200">
              The gallery could not load.
            </p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-zinc-500">
              {error}
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-5 flex h-9 items-center gap-2 rounded-full border border-zinc-700 px-4 text-[13px] text-zinc-200 transition-colors hover:bg-white/10"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Try again
            </button>
          </div>
        )}

        {/* empty — the conversion hook */}
        {items !== null && !error && items.length === 0 && (
          <div className="mx-auto flex max-w-md flex-col items-center py-14 text-center">
            <div className="relative mb-5">
              <div
                aria-hidden
                className="absolute inset-0 -z-10 scale-150 rounded-full bg-amber-400/10 blur-3xl"
              />
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-amber-300/20 bg-amber-400/10">
                <Images className="h-7 w-7 text-amber-300" aria-hidden />
              </span>
            </div>
            <h2 className="text-[20px] font-semibold tracking-tight text-white">
              Nothing forged yet
            </h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-zinc-400">
              Every image the forge makes lands here — from every chat,
              newest first, with its full receipt.
            </p>
            <button
              type="button"
              onClick={startForging}
              className="mt-6 flex h-10 items-center gap-2 rounded-full border border-amber-400/40 bg-amber-400/10 px-5 text-[13.5px] font-medium text-amber-200 transition-all hover:-translate-y-0.5 hover:border-amber-400/60 hover:bg-amber-400/20"
            >
              <Sparkles className="h-4 w-4" aria-hidden />
              Forge your first image
            </button>
          </div>
        )}

        {/* the masonry */}
        {items !== null && items.length > 0 && (
          <div className="mx-auto max-w-6xl columns-2 gap-3 sm:columns-3 lg:columns-4 2xl:columns-5 [column-fill:balance]">
            {items.map((item, i) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setZoom(i)}
                aria-label={`Open image: ${item.image.prompt}`}
                style={
                  {
                    "--d": `${Math.min(i * 40, 480)}ms`,
                  } as React.CSSProperties
                }
                className="hermes-fade-up group relative mb-3 block w-full break-inside-avoid overflow-hidden rounded-xl border border-zinc-800 bg-[#1d1d20] transition-colors [animation-delay:var(--d)] hover:border-amber-400/30 focus-visible:border-amber-400/50 focus-visible:outline-none"
              >
                {/* Plain img: the file route serves immutable-cached
                    bytes with exact dimensions — next/image adds
                    nothing here (same call as the timeline card). */}
                <img
                  src={`/api/image/file/${item.image.id}`}
                  alt={`Generated image — ${item.image.prompt}`}
                  width={item.image.width}
                  height={item.image.height}
                  loading="lazy"
                  className="h-auto w-full"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/85 via-black/25 to-transparent p-3 opacity-0 transition-opacity duration-200 group-focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <span className="line-clamp-2 text-left text-[12px] font-medium leading-snug text-white">
                    {item.image.prompt}
                  </span>
                  <span className="mt-1 flex items-center gap-1 truncate text-left text-[10.5px] text-zinc-400">
                    <MessageSquare className="h-3 w-3 shrink-0" />
                    {item.chatTitle} · {timeAgo(item.createdAt)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* lightbox — full provenance, keyboard browsing, open-in-chat */}
      {active && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/90 p-4 sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={`Generated image — ${active.image.prompt}`}
          onClick={() => setZoom(null)}
        >
          {/* prev / next — walk the whole collection */}
          {items !== null && items.length > 1 && (
            <>
              <button
                type="button"
                aria-label="Previous image"
                onClick={(e) => {
                  e.stopPropagation();
                  setZoom(
                    (z) =>
                      z === null
                        ? z
                        : (z - 1 + items.length) % items.length
                  );
                }}
                className="absolute left-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-zinc-700 bg-black/60 text-zinc-200 transition-colors hover:bg-white/20"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                type="button"
                aria-label="Next image"
                onClick={(e) => {
                  e.stopPropagation();
                  setZoom((z) => (z === null ? z : (z + 1) % items.length));
                }}
                className="absolute right-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-zinc-700 bg-black/60 text-zinc-200 transition-colors hover:bg-white/20"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </>
          )}

          <img
            src={`/api/image/file/${active.image.id}`}
            alt={`Generated image — ${active.image.prompt}`}
            className="max-h-[72vh] max-w-full cursor-zoom-out rounded-lg object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />

          <div
            className="flex max-w-3xl flex-col items-center gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <p
              className="line-clamp-2 text-center text-[13.5px] leading-relaxed text-zinc-200"
              title={active.image.prompt}
            >
              {active.image.prompt}
            </p>
            <p className="text-center text-[11.5px] tabular-nums text-zinc-500">
              {active.image.width}×{active.image.height} ·{" "}
              {formatKB(active.image.bytes)} ·{" "}
              {(active.image.ms / 1000).toFixed(1)}s · {fullDate(active.createdAt)}
              {items !== null && items.length > 1
                ? ` · ${(zoom ?? 0) + 1} / ${items.length}`
                : ""}
            </p>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => openInChat(active.chatId)}
                className="flex h-8 items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-400/10 px-3.5 text-[12px] font-medium text-amber-200 transition-colors hover:bg-amber-400/20"
                title={`Open “${active.chatTitle}”`}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Open in chat
              </button>
              <a
                href={`/api/image/file/${active.image.id}?download=1`}
                download
                className="flex h-8 items-center gap-1.5 rounded-full border border-zinc-600 bg-white/10 px-3.5 text-[12px] font-medium text-zinc-100 transition-colors hover:bg-white/20"
              >
                <Download className="h-3.5 w-3.5" />
                Download
              </a>
              <button
                type="button"
                onClick={() => setZoom(null)}
                className="flex h-8 items-center gap-1.5 rounded-full border border-zinc-700 px-3.5 text-[12px] text-zinc-300 transition-colors hover:bg-white/10"
              >
                <X className="h-3.5 w-3.5" />
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
