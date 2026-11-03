"use client";

// Hermes — Run 29: THE SIGNATURE FIRST SCREEN.
//
// The welcome screen is the only conversion surface this product has
// — every visitor's first pixel. A brutal design audit of the old
// layout scored it 5.5/10: "competent, clean, and completely
// interchangeable" — a status-message headline ("gateway online"),
// four consecutive rows of same-weight pills (clock + memory + three
// stat chips), starter cards clipped behind the composer, timid
// background blobs. This is the fix, as one coherent redesign:
//
//   • SPARKLE FIELD — a live canvas of golden eureka-dust that reacts
//     to the pointer and bursts on every press (see SparkleField.tsx).
//     The signature moment; the page answers your presence.
//   • A REAL HEADLINE — a time-aware two-line lockup: quiet greeting
//     line, then the owner's name at display scale in an amber
//     gradient (late night gets the brand easter egg: "Swift as
//     thought, still awake, Hermes?"). Hydration-safe: this component only
//     mounts client-side after bootstrap — `booted` gates it upstream.
//   • ONE PULSE LINE — the live clock and the gateway's real numbers
//     merged into a single typographic line (no more chip soup); the
//     stats portion is a button that opens the token ledger. Numbers
//     still count up from real limiter data; unknown data still
//     renders nothing (never a fake digit).
//   • NO CLIPPING — a compact rhythm that fits whole above the
//     composer on ≥720px viewports, plus a bottom fade overlay so any
//     overflow on shorter screens reads as designed, not broken.
//
// Everything that already worked stays: one-click starters (with the
// web-search variant), the amber memory chip (only when something is
// actually remembered), the breathing health ring around the logo
// (emerald = keys healthy, amber = limiter warning), the staggered
// cinematic entrance, and every reduced-motion escape hatch.

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import {
  Brain,
  Code2,
  Globe,
  GraduationCap,
  ListChecks,
} from "lucide-react";
import { useHermes } from "@/lib/store";
import { useNow } from "@/hooks/use-now";
import { useCountUp } from "@/hooks/use-count-up";
import {
  USER_TIMEZONE_LABEL,
  liveDate,
  liveTime,
} from "@/lib/hermes/constants";
import { formatCompact, formatFull } from "@/lib/hermes/format";
import type { LimiterStatus } from "@/lib/hermes/types";
import { SparkleField } from "./SparkleField";

/** Time-aware headline lockup. "Swift as thought" — Hermes' own
 *  epithet, the messenger god — reserved for the 23:00–05:00 crowd
 *  who earn it. */
function greetingLockup(name: string): { hello: string; who: string } {
  const who = name ? name[0].toUpperCase() + name.slice(1) : "friend";
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return { hello: "Good morning,", who: `${who}.` };
  if (h < 17) return { hello: "Good afternoon,", who: `${who}.` };
  if (h < 23) return { hello: "Good evening,", who: `${who}.` };
  return { hello: "Swift as thought, still awake,", who: `${who}?` };
}

/** Run 41 — THE LIVING POOL: seat dot tone for a key's live state.
 *  Emerald = probe-verified live; amber = needs the daily dashboard
 *  check-in; rose = breaker-held / not responding; zinc = unproven. */
function seatTone(state: string): string {
  switch (state) {
    case "serving":
      return "border-emerald-300/70 bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]";
    case "checkin":
      return "border-amber-300/80 bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.7)]";
    case "cooling":
      return "border-rose-300/60 bg-rose-400";
    case "down":
      return "border-rose-400/50 bg-rose-500/70";
    default:
      return "border-zinc-500/60 bg-zinc-600";
  }
}

function seatText(k: {
  label: string;
  live?: { state: string; lastLatencyMs: number | null } | null;
}): string {
  const s = k.live?.state ?? "unproven";
  const base =
    s === "serving"
      ? `serving${k.live?.lastLatencyMs ? ` · ${k.live.lastLatencyMs}ms probe` : ""}`
      : s === "checkin"
        ? "needs a daily check-in"
        : s === "cooling"
          ? "cooling down"
          : s === "down"
            ? "not responding"
            : "probing…";
  return `${k.label} — ${base}`;
}

/** The pulse line's pool segment — honest counts only: when the
 *  prober has not spoken yet, the UI says "pooled", never "live". */
function PoolCount({ limiter }: { limiter: LimiterStatus }) {
  const serving = limiter.servingKeys;
  const label =
    serving === null
      ? `key${limiter.activeKeys === 1 ? "" : "s"} pooled`
      : `of ${limiter.activeKeys} key${limiter.activeKeys === 1 ? "" : "s"} serving`;
  const detail =
    serving === null
      ? `${limiter.activeKeys} active key${limiter.activeKeys === 1 ? "" : "s"} in the ${limiter.providerName} pool`
      : `${serving} of ${limiter.activeKeys} ${limiter.providerName} keys probe-verified live right now`;
  return (
    <span title={detail}>
      <span className="font-semibold text-zinc-200">
        {serving ?? limiter.activeKeys}
      </span>{" "}
      {serving !== null && (
        <span className="text-zinc-600" aria-hidden>
          /
        </span>{" "}
      )}
      {label}
    </span>
  );
}

/** The gateway's pulse — live clock + real stats as ONE typographic
 *  line (Run 29: replaces the old separate clock paragraph and the
 *  three-chip stat strip). The stats portion is a button into the
 *  token ledger. Honesty rules carried over: numbers count up from
 *  the limiter's real aggregates, and unknown data renders nothing. */
function PulseLine({
  limiter,
  onOpenLimiter,
}: {
  limiter: LimiterStatus | null;
  onOpenLimiter: () => void;
}) {
  const now = useNow();
  const today = useCountUp(limiter?.dailyTokens ?? null);
  const allTime = useCountUp(limiter?.allTimeTokens ?? null);

  // Run 41 — a partially-dead pool is a warning tone, not a green dot:
  // the ring's emerald promise is only kept when every pooled key serves.
  const warn =
    Boolean(limiter?.warning) ||
    (limiter?.servingKeys != null && limiter.servingKeys < limiter.activeKeys);

  // Reserve the line's height before the clock mounts — no shift.
  if (!now) return <div className="mt-3.5 h-4" aria-hidden />;

  const sep = (
    <span className="mx-1.5 text-zinc-700" aria-hidden>
      ·
    </span>
  );

  return (
    <div className="hermes-w-pulse hermes-fade-up mt-3.5 flex flex-wrap items-center justify-center gap-x-1 gap-y-1 text-[12px] text-zinc-500 [animation-delay:150ms]">
      {/* live clock — proof every answer is grounded in real "now" */}
      <span
        className="flex items-center gap-2 tabular-nums"
        title="Every answer is grounded in this live local time"
      >
        <span className="relative flex h-1.5 w-1.5">
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${
              warn ? "bg-amber-400" : "bg-emerald-400"
            }`}
          />
          <span
            className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
              warn ? "bg-amber-400" : "bg-emerald-400"
            }`}
          />
        </span>
        {liveDate(now)} · {liveTime(true, now)}{" "}
        <span className="text-zinc-600">({USER_TIMEZONE_LABEL})</span>
      </span>

      {/* the gateway's real numbers — one click opens the ledger */}
      {limiter && (
        <>
          {sep}
          <button
            onClick={onOpenLimiter}
            aria-label="Gateway pulse — open the token ledger"
            className="-mx-1.5 rounded-md px-1.5 tabular-nums transition-colors hover:text-zinc-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-600"
          >
            <span
              title={`Exactly ${formatFull(limiter.dailyTokens)} tokens used today — resets daily at 01:00 (Africa/Algiers)`}
            >
              <span className="font-semibold text-zinc-200">
                {today === null ? "…" : formatCompact(today)}
              </span>{" "}
              today
            </span>
            {sep}
            <span
              title={`Exactly ${formatFull(limiter.allTimeTokens)} tokens routed through the gateway, all time`}
            >
              <span className="font-semibold text-zinc-200">
                {allTime === null ? "…" : formatCompact(allTime)}
              </span>{" "}
              all-time
            </span>
            {sep}
            <PoolCount limiter={limiter} />
            <span className="text-zinc-600" aria-hidden>
              {" "}
              · {limiter.providerName}
            </span>
          </button>
        </>
      )}
    </div>
  );
}

const STARTERS = [
  {
    icon: GraduationCap,
    title: "Explain like I'm five",
    desc: "Hard ideas, made simple",
    prompt:
      "Explain how large language models work like I'm five — concise, no jargon.",
  },
  {
    icon: Code2,
    title: "Write code",
    desc: "A working snippet, fast",
    prompt:
      "Write a TypeScript debounce function with full types and a usage example.",
  },
  {
    icon: Globe,
    title: "Search the web",
    desc: "Fresh, cited answers",
    prompt:
      "What are the latest AI model releases this month? Summarize briefly.",
    search: true,
  },
  {
    icon: ListChecks,
    title: "Summarize",
    desc: "Key points in bullets",
    prompt: "Summarize the core ideas of Atomic Habits in 5 bullet points.",
  },
];

export function WelcomeScreen({
  onOpenMemory,
  onOpenLimiter,
  onOpenProviders,
}: {
  onOpenMemory: () => void;
  onOpenLimiter: () => void;
  onOpenProviders: () => void;
}) {
  const { user, sendMessage, setSearchEnabled, limiter, memories, providers } =
    useHermes();

  // The bottom fade only earns its place when the content actually
  // overflows (short viewports) — when everything fits, the last
  // card and the ⌘K hint stay crisp, with no permanent vignette.
  // Observed on both the scroll viewport (window resizes) and the
  // content wrapper (its own height changes), so mode switches and
  // memory-chip appearances are both covered.
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const check = () =>
      setOverflowing(scroller.scrollHeight > scroller.clientHeight + 1);
    const ro = new ResizeObserver(check);
    ro.observe(scroller);
    ro.observe(content);
    check();
    return () => ro.disconnect();
  }, []);

  const fire = (prompt: string, withSearch?: boolean) => {
    if (withSearch) setSearchEnabled(true);
    void sendMessage(prompt);
  };

  // Computed once per mount (client-only — `booted` gates this
  // component upstream, so there is no SSR frame to mismatch).
  const lockup = greetingLockup(user.name);

  // The gateway's real pulse — drives the health ring tone.
  const pulse = limiter;
  // Run 41 — the tone is honest: amber when ANY pooled key is not
  // probe-verified live (or the limiter raised a warning).
  const warn =
    Boolean(pulse?.warning) ||
    (pulse?.servingKeys != null && pulse.servingKeys < pulse.activeKeys);

  // THE LIVING MEDALLION — the active pool's seats orbit the mark
  // itself, each dot the key's real color right now. The homepage
  // stops asserting health and starts SHOWING it; one click opens
  // the full orrery.
  const activeProvider = providers.find((p) => p.isActive);
  const ringKeys = (activeProvider?.keys ?? []).filter((k) => k.isActive);

  return (
    <div className="hermes-welcome relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="hermes-scroll relative flex flex-1 flex-col overflow-y-auto px-4 text-center"
      >
        {/* aurora backdrop (behind the sparkle field) */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-20 overflow-hidden"
        >
          <div className="hermes-aurora absolute left-[6%] top-[10%] h-72 w-72 rounded-full bg-emerald-500/[0.07] blur-3xl" />
          <div className="hermes-aurora-b absolute right-[4%] top-[32%] h-80 w-80 rounded-full bg-amber-500/[0.06] blur-3xl" />
          <div className="hermes-aurora absolute bottom-[6%] left-[30%] h-64 w-64 rounded-full bg-violet-500/[0.05] blur-3xl [animation-delay:-9s]" />
        </div>

        {/* the signature layer — golden eureka-dust, alive under the
            cursor, bursting on every press (aria-hidden canvas) */}
        <SparkleField />

        {/* vertically centered content — my-auto keeps the lockup
            visible even when the viewport is short */}
        <div
          ref={contentRef}
          className="hermes-w-pt hermes-w-pb my-auto flex w-full flex-col items-center pt-7 pb-16"
        >
          {/* logo — the Hermes medallion: the official caduceus staged
              in amber light inside a hairline plate, under a rotating
              gold health sweep (the medallion warms up entirely when
              the limiter raises a warning; the PulseLine dot carries
              the quiet emerald state). Everything is inset-relative,
              so the compact-mode media queries shrink the whole
              emblem proportionally. */}
          {/* THE LIVING MEDALLION (Run 41) — a button: the seats ARE
              the pool. Hover warms the ring; click opens the orrery. */}
          <button
            type="button"
            onClick={onOpenProviders}
            aria-label={`Key pool: ${ringKeys.length ? `${ringKeys.filter((k) => k.live?.state === "serving").length} of ${ringKeys.length} keys serving — open Manage Providers` : "open Manage Providers"}`}
            className={`hermes-w-logo-wrap hermes-bloom group relative mb-5 cursor-pointer transition-transform duration-300 hover:scale-[1.04] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-400/60 ${
              warn ? "hermes-warn" : ""
            }`}
          >
            {/* halo — a real glow: amber light falling off into the dark
                (replaces the old blur blob that read as a smudge) */}
            <span
              aria-hidden
              className="hermes-medallion-glow absolute -inset-10 -z-20 rounded-full"
            />
            {/* the plate — a defined stage for the mark, not a void */}
            <span
              aria-hidden
              className="hermes-medallion-plate absolute -inset-2.5 -z-10 rounded-full border border-white/[0.08]"
            />
            {pulse && (
              <>
                {/* full track — committed to brand gold so the ring
                    reads as designed at every rotation angle */}
                <span
                  aria-hidden
                  className="hermes-medallion-track absolute -inset-4 rounded-full"
                />
                <span
                  aria-hidden
                  className={`hermes-pulse-ring absolute -inset-4 rounded-full ${
                    warn ? "hermes-pulse-warn" : ""
                  }`}
                />
              </>
            )}
            {/* the orbiting seats — one per ACTIVE key, riding the
                pulse-ring track at radius 48px. The layer turns at
                80s/rev; reduced-motion holds it still. */}
            {ringKeys.length > 0 && (
              <span
                aria-hidden
                className="pointer-events-none absolute -inset-4 motion-reduce:!animate-none"
                style={{ animation: "hermes-spin-slow 80s linear infinite" }}
              >
                {ringKeys.map((k, i) => {
                  const angle =
                    (-90 + (i * 360) / ringKeys.length) * (Math.PI / 180);
                  const left = 50 + 50 * Math.cos(angle);
                  const top = 50 + 50 * Math.sin(angle);
                  const state = k.live?.state ?? "unproven";
                  return (
                    <span
                      key={k.id}
                      title={seatText(k)}
                      className="absolute flex h-3 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
                      style={{ left: `${left}%`, top: `${top}%` }}
                    >
                      <span
                        className={`h-2.5 w-2.5 rounded-full border transition-[filter] duration-300 group-hover:brightness-125 ${seatTone(state)} ${
                          state === "checkin" ? "animate-pulse" : ""
                        }`}
                      />
                    </span>
                  );
                })}
              </span>
            )}
            <Image
              src="/hermes-mark.png"
              alt="Hermes logo — open the key pool"
              width={875}
              height={1124}
              className="hermes-w-logo hermes-float h-16 w-16 object-contain object-center drop-shadow-[0_0_24px_rgba(251,191,36,0.3)]"
              priority
            />
          </button>

          {/* the headline lockup — quiet greeting, then the name at
              display scale in brand gold */}
          <h1 className="hermes-fade-up [animation-delay:60ms]">
            <span className="hermes-w-hello block text-[clamp(19px,3vw,27px)] font-medium text-zinc-300">
              {lockup.hello}
            </span>
            <span className="hermes-w-name-wrap mt-1 block text-[clamp(33px,5.5vw,50px)] font-semibold leading-[1.05] tracking-tight">
              <span className="hermes-w-name bg-gradient-to-br from-amber-100 via-amber-300 to-amber-500 bg-clip-text text-transparent drop-shadow-[0_0_28px_rgba(251,191,36,0.22)]">
                {lockup.who}
              </span>
            </span>
          </h1>
          <p className="hermes-w-sub hermes-fade-up mt-3 max-w-lg text-[13.5px] leading-relaxed text-zinc-500 [animation-delay:120ms]">
            Pooled routing, prompt caching, web search — one gateway,
            every model.
          </p>

          <PulseLine limiter={limiter} onOpenLimiter={onOpenLimiter} />

          {/* the gateway's living memory: real count, honest copy, one
              click to edit. Only rendered when something is actually
              remembered — an empty memory stays silent. */}
          {memories.length > 0 && (
            <button
              onClick={onOpenMemory}
              title="What Hermes always remembers about you — click to edit"
              className="hermes-w-mem hermes-fade-up mt-2.5 flex items-center gap-2 rounded-full border border-amber-400/25 bg-amber-400/[0.07] px-3.5 py-1.5 text-[12px] text-amber-200/90 transition-colors hover:border-amber-400/45 hover:bg-amber-400/[0.12] [animation-delay:180ms]"
            >
              <Brain className="h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden />
              <span className="tabular-nums">
                Remembers{" "}
                <span className="font-semibold text-amber-100">
                  {memories.length}
                </span>{" "}
                thing{memories.length === 1 ? "" : "s"} about you
              </span>
              <span className="text-amber-200/50" aria-hidden>
                ·
              </span>
              <span className="text-amber-200/70">Edit</span>
            </button>
          )}

          {/* one-click starter prompts — compact cards with a glass
              whisper (the sparkle field glows through them) */}
          <div className="hermes-w-cards mt-6 grid w-full max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2">
            {STARTERS.map((s, i) => (
              <button
                key={s.title}
                onClick={() => fire(s.prompt, s.search)}
                style={{ "--d": `${210 + i * 55}ms` } as React.CSSProperties}
                className="hermes-w-card hermes-fade-up group flex items-center gap-3 rounded-xl border border-zinc-800/80 bg-[#1d1d20]/70 p-3 text-left backdrop-blur-sm transition-all [animation-delay:var(--d)] hover:-translate-y-0.5 hover:border-amber-400/40 hover:bg-[#222225] hover:shadow-[0_10px_32px_-14px_rgba(251,191,36,0.4)]"
              >
                <span className="hermes-w-card-ic flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-700/60 bg-zinc-800/50 text-amber-200/60 transition-colors group-hover:border-amber-400/30 group-hover:bg-amber-400/10 group-hover:text-amber-300">
                  <s.icon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-zinc-200">
                    {s.title}
                  </span>
                  <span className="block truncate text-[11.5px] text-zinc-500">
                    {s.desc}
                  </span>
                </span>
              </button>
            ))}
          </div>

          <p className="hermes-w-hint hermes-fade-up mt-5 hidden items-center gap-1.5 text-[11.5px] text-zinc-600 sm:flex [animation-delay:460ms]">
            Press
            <kbd className="rounded border border-zinc-700 bg-zinc-800/70 px-1.5 py-0.5 font-sans text-[10px] font-medium text-zinc-400">
              ⌘K
            </kbd>
            to search every message, model &amp; action
          </p>
        </div>
      </div>

      {/* graceful overflow — ONLY when the content actually
          overflows (short viewports): it fades toward the composer
          instead of being hard-clipped. When everything fits, the
          fade stays out entirely (pointer-events-none either way,
          nothing underneath is ever blocked) */}
      {overflowing && (
        <div
          aria-hidden
          className="hermes-w-fade pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent to-[#18181b]"
        />
      )}
    </div>
  );
}
