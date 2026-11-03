"use client";

// SenkuAPI — Run 29: THE SIGNATURE FIRST SCREEN.
//
// The welcome screen is the only conversion surface this product has
// — every visitor's first pixel. A brutal design audit of the old
// layout scored it 5.5/10: "competent, clean, and completely
// interchangeable" — a status-message headline ("senku returns!"),
// four consecutive rows of same-weight pills (clock + memory + three
// stat chips), starter cards clipped behind the composer, timid
// background blobs. This is the fix, as one coherent redesign:
//
//   • SPARKLE FIELD — a live canvas of golden eureka-dust that reacts
//     to the pointer and bursts on every press (see SparkleField.tsx).
//     The signature moment; the page answers your presence.
//   • A REAL HEADLINE — a time-aware two-line lockup: quiet greeting
//     line, then the owner's name at display scale in an amber
//     gradient (late night gets the brand easter egg: "10 billion
//     percent still up, Senku?"). Hydration-safe: this component only
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
import { useSenku } from "@/lib/store";
import { useNow } from "@/hooks/use-now";
import { useCountUp } from "@/hooks/use-count-up";
import {
  USER_TIMEZONE_LABEL,
  liveDate,
  liveTime,
} from "@/lib/senku/constants";
import { formatCompact, formatFull } from "@/lib/senku/format";
import type { LimiterStatus } from "@/lib/senku/types";
import { SparkleField } from "./SparkleField";

/** Time-aware headline lockup. "10 billion percent" is Senku's own
 *  catchphrase — reserved for the 23:00–05:00 crowd who earn it. */
function greetingLockup(name: string): { hello: string; who: string } {
  const who = name ? name[0].toUpperCase() + name.slice(1) : "friend";
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return { hello: "Good morning,", who: `${who}.` };
  if (h < 17) return { hello: "Good afternoon,", who: `${who}.` };
  if (h < 23) return { hello: "Good evening,", who: `${who}.` };
  return { hello: "10 billion percent still up,", who: `${who}?` };
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

  const warn = Boolean(limiter?.warning);

  // Reserve the line's height before the clock mounts — no shift.
  if (!now) return <div className="mt-3.5 h-4" aria-hidden />;

  const sep = (
    <span className="mx-1.5 text-zinc-700" aria-hidden>
      ·
    </span>
  );

  return (
    <div className="senku-w-pulse senku-fade-up mt-3.5 flex flex-wrap items-center justify-center gap-x-1 gap-y-1 text-[12px] text-zinc-500 [animation-delay:150ms]">
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
            <span
              title={`${limiter.activeKeys} active key${limiter.activeKeys === 1 ? "" : "s"} in the ${limiter.providerName} pool${warn ? " · the limiter raised a warning" : ""}`}
            >
              <span className="font-semibold text-zinc-200">
                {limiter.activeKeys}
              </span>{" "}
              key{limiter.activeKeys === 1 ? "" : "s"} live
            </span>
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
}: {
  onOpenMemory: () => void;
  onOpenLimiter: () => void;
}) {
  const { user, sendMessage, setSearchEnabled, limiter, memories } = useSenku();

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
  const warn = Boolean(pulse?.warning);

  return (
    <div className="senku-welcome relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="senku-scroll relative flex flex-1 flex-col overflow-y-auto px-4 text-center"
      >
        {/* aurora backdrop (behind the sparkle field) */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-20 overflow-hidden"
        >
          <div className="senku-aurora absolute left-[6%] top-[10%] h-72 w-72 rounded-full bg-emerald-500/[0.07] blur-3xl" />
          <div className="senku-aurora-b absolute right-[4%] top-[32%] h-80 w-80 rounded-full bg-amber-500/[0.06] blur-3xl" />
          <div className="senku-aurora absolute bottom-[6%] left-[30%] h-64 w-64 rounded-full bg-violet-500/[0.05] blur-3xl [animation-delay:-9s]" />
        </div>

        {/* the signature layer — golden eureka-dust, alive under the
            cursor, bursting on every press (aria-hidden canvas) */}
        <SparkleField />

        {/* vertically centered content — my-auto keeps the lockup
            visible even when the viewport is short */}
        <div
          ref={contentRef}
          className="senku-w-pt senku-w-pb my-auto flex w-full flex-col items-center pt-7 pb-16"
        >
          {/* logo — the breathing health ring stays: emerald = keys
              healthy, amber = the limiter raised a warning */}
          <div className="senku-w-logo-wrap senku-bloom relative mb-4">
            <div
              aria-hidden
              className="absolute inset-0 -z-10 scale-150 rounded-full bg-amber-400/10 blur-3xl"
            />
            {pulse && (
              <span
                aria-hidden
                className={`senku-pulse-ring absolute -inset-3 rounded-full ${
                  warn ? "senku-pulse-warn" : ""
                }`}
              />
            )}
            <Image
              src="/senku-sparkle.png"
              alt="SenkuAPI logo"
              width={64}
              height={64}
              className="senku-w-logo senku-float h-14 w-14 drop-shadow-[0_0_24px_rgba(251,191,36,0.25)]"
              priority
            />
          </div>

          {/* the headline lockup — quiet greeting, then the name at
              display scale in brand gold */}
          <h1 className="senku-fade-up [animation-delay:60ms]">
            <span className="senku-w-hello block text-[clamp(19px,3vw,27px)] font-medium text-zinc-400">
              {lockup.hello}
            </span>
            <span className="senku-w-name-wrap mt-1 block text-[clamp(33px,5.5vw,50px)] font-semibold leading-[1.05] tracking-tight">
              <span className="senku-w-name bg-gradient-to-br from-amber-100 via-amber-300 to-amber-500 bg-clip-text text-transparent drop-shadow-[0_0_28px_rgba(251,191,36,0.22)]">
                {lockup.who}
              </span>
            </span>
          </h1>
          <p className="senku-w-sub senku-fade-up mt-3 max-w-lg text-[13.5px] leading-relaxed text-zinc-500 [animation-delay:120ms]">
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
              title="What SenkuAPI always remembers about you — click to edit"
              className="senku-w-mem senku-fade-up mt-2.5 flex items-center gap-2 rounded-full border border-amber-400/25 bg-amber-400/[0.07] px-3.5 py-1.5 text-[12px] text-amber-200/90 transition-colors hover:border-amber-400/45 hover:bg-amber-400/[0.12] [animation-delay:180ms]"
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
          <div className="senku-w-cards mt-6 grid w-full max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2">
            {STARTERS.map((s, i) => (
              <button
                key={s.title}
                onClick={() => fire(s.prompt, s.search)}
                style={{ "--d": `${210 + i * 55}ms` } as React.CSSProperties}
                className="senku-w-card senku-fade-up group flex items-center gap-3 rounded-xl border border-zinc-800/80 bg-[#1d1d20]/70 p-3 text-left backdrop-blur-sm transition-all [animation-delay:var(--d)] hover:-translate-y-0.5 hover:border-amber-400/40 hover:bg-[#222225] hover:shadow-[0_10px_32px_-14px_rgba(251,191,36,0.4)]"
              >
                <span className="senku-w-card-ic flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-700/60 bg-zinc-800/50 text-amber-200/60 transition-colors group-hover:border-amber-400/30 group-hover:bg-amber-400/10 group-hover:text-amber-300">
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

          <p className="senku-w-hint senku-fade-up mt-5 hidden items-center gap-1.5 text-[11.5px] text-zinc-600 sm:flex [animation-delay:460ms]">
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
          className="senku-w-fade pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent to-[#18181b]"
        />
      )}
    </div>
  );
}
