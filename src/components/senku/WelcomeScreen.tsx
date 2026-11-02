"use client";

// SenkuAPI — welcome screen. Clean and focused: logo, greeting,
// live local clock and one-click starter prompts. No plan badges,
// no model pickers — the model always starts on the default (glm-5.3).
//
// Run 19 — THE LIVING GATEWAY: the entry moment now shows the
// gateway's real pulse instead of a static page. A breathing health
// ring wraps the logo (emerald = keys healthy, amber = the limiter
// raised a warning), a live stat strip counts up the gateway's REAL
// numbers (today · all-time · keys live — straight from the
// bootstrap limiter, never estimated, hidden entirely when the
// limiter is unknown — never a fake digit), and the whole block
// settles in as one staggered cinematic sequence. Reduced-motion:
// everything lands instantly, numbers jump to their values.
// (Run 20's engine bay was removed on user feedback — the composer
// picker already owns model switching; the welcome stays pure.)

import Image from "next/image";
import {
  Code2,
  Globe,
  GraduationCap,
  Infinity as InfinityIcon,
  KeyRound,
  ListChecks,
  Zap,
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

/** Pulsing live clock — proof the gateway answers with real "now". */
function LiveClock() {
  const now = useNow();

  // Reserve one line of height before mount (no layout shift, no
  // hydration mismatch — the server never renders a clock).
  if (!now) return <div className="mt-3.5 h-5" aria-hidden />;

  return (
    <p
      className="senku-fade-up mt-3.5 flex items-center justify-center gap-2 text-[13px] tabular-nums text-zinc-500 [animation-delay:120ms]"
      title="Every answer is grounded in this live local time"
    >
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
      </span>
      <span>
        {liveDate(now)} · {liveTime(true, now)}{" "}
        <span className="text-zinc-600">({USER_TIMEZONE_LABEL})</span>
      </span>
    </p>
  );
}

/** Run 19 — one live stat chip. Numbers count up from the gateway's
 *  real limiter data; if the value isn't known the chip renders
 *  nothing at all (no dashes that look like zeros, no fake state). */
function StatChip({
  icon: Icon,
  label,
  target,
  tone,
  delayMs,
  title,
}: {
  icon: typeof Zap;
  label: string;
  target: number | null;
  tone: "emerald" | "zinc";
  delayMs: number;
  title: string;
}) {
  const value = useCountUp(target);

  return (
    <span
      className="senku-fade-up flex items-center gap-1.5 rounded-full border border-zinc-800 bg-[#1d1d20]/80 px-3 py-1.5 text-[12px] text-zinc-300 [animation-delay:var(--d)]"
      style={{ "--d": `${delayMs}ms` } as React.CSSProperties}
      title={title}
    >
      <Icon
        className={`h-3.5 w-3.5 shrink-0 ${
          tone === "emerald" ? "text-emerald-400" : "text-zinc-500"
        }`}
        aria-hidden
      />
      {value === null ? null : (
        <span className="tabular-nums">
          <span className="font-semibold text-white">
            {formatCompact(value)}
          </span>{" "}
          {label}
        </span>
      )}
    </span>
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

export function WelcomeScreen() {
  const { user, sendMessage, setSearchEnabled, limiter } = useSenku();

  const fire = (prompt: string, withSearch?: boolean) => {
    if (withSearch) setSearchEnabled(true);
    void sendMessage(prompt);
  };

  // The gateway's real pulse. `warning` is the limiter's own voice —
  // amber ring means the gateway itself is asking for attention.
  const pulse = limiter;
  const warn = Boolean(pulse?.warning);

  return (
    <div className="senku-scroll relative flex flex-1 flex-col overflow-y-auto px-4 text-center">
      {/* aurora backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        <div className="senku-aurora absolute left-[6%] top-[10%] h-72 w-72 rounded-full bg-emerald-500/[0.07] blur-3xl" />
        <div className="senku-aurora-b absolute right-[4%] top-[32%] h-80 w-80 rounded-full bg-amber-500/[0.06] blur-3xl" />
        <div className="senku-aurora absolute bottom-[6%] left-[30%] h-64 w-64 rounded-full bg-violet-500/[0.05] blur-3xl [animation-delay:-9s]" />
      </div>

      {/* vertically centered content — my-auto keeps the logo visible
          even when the viewport is short (no clipping, ever) */}
      <div className="my-auto flex flex-col items-center py-10">
        {/* logo — wrapped in the gateway's breathing health ring when
            the limiter is live; plain glow when it isn't. Bloom is a
            one-time settle; the float bob continues after. */}
        <div className="senku-bloom relative mb-5">
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
            className="senku-float h-16 w-16 drop-shadow-[0_0_24px_rgba(251,191,36,0.25)]"
            priority
          />
        </div>

        <h1 className="senku-fade-up text-[28px] font-semibold tracking-tight text-white [animation-delay:60ms]">
          {user.name} returns!
        </h1>
        <p className="senku-fade-up mt-2 max-w-xl text-[15px] leading-relaxed text-zinc-400 [animation-delay:90ms]">
          Pooled key routing, prompt caching, and OpenAI compatibility. What
          can I help you with today?
        </p>

        <LiveClock />

        {/* Run 19 — the gateway's live stat strip. REAL numbers only:
            today's usage, all-time usage, keys in the active pool +
            provider name. Hidden completely when the limiter hasn't
            reported — this strip never guesses. */}
        {pulse && (
          <div
            role="group"
            aria-label="Live gateway stats"
            className="mt-4 flex flex-wrap items-center justify-center gap-2"
          >
            <StatChip
              icon={Zap}
              label="tok today"
              target={pulse.dailyTokens}
              tone="emerald"
              delayMs={180}
              title={`Exactly ${formatFull(pulse.dailyTokens)} tokens used today — resets daily at 01:00 (Africa/Algiers)`}
            />
            <StatChip
              icon={InfinityIcon}
              label="all-time"
              target={pulse.allTimeTokens}
              tone="zinc"
              delayMs={240}
              title={`Exactly ${formatFull(pulse.allTimeTokens)} tokens routed through the gateway, all time`}
            />
            <span
              className="senku-fade-up flex items-center gap-1.5 rounded-full border border-zinc-800 bg-[#1d1d20]/80 px-3 py-1.5 text-[12px] text-zinc-300 [animation-delay:300ms]"
              title={`${pulse.activeKeys} active key${pulse.activeKeys === 1 ? "" : "s"} in the ${pulse.providerName} pool${warn ? " · the limiter raised a warning" : ""}`}
            >
              <KeyRound
                className={`h-3.5 w-3.5 shrink-0 ${
                  warn ? "text-amber-400" : "text-emerald-400"
                }`}
                aria-hidden
              />
              <span className="tabular-nums">
                <span className="font-semibold text-white">
                  {pulse.activeKeys}
                </span>{" "}
                key{pulse.activeKeys === 1 ? "" : "s"} live ·{" "}
                {pulse.providerName}
              </span>
              <span
                aria-hidden
                className={`relative flex h-1.5 w-1.5 ${
                  warn ? "" : "ml-0.5"
                }`}
              >
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
            </span>
          </div>
        )}

        {/* one-click starter prompts — staggered cascade + warm glow */}
        <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
          {STARTERS.map((s, i) => (
            <button
              key={s.title}
              onClick={() => fire(s.prompt, s.search)}
              style={{ "--d": `${140 + i * 60}ms` } as React.CSSProperties}
              className="senku-fade-up group flex items-center gap-3 rounded-xl border border-zinc-800 bg-[#1d1d20]/80 p-3.5 text-left transition-all [animation-delay:var(--d)] hover:-translate-y-0.5 hover:border-amber-400/35 hover:bg-[#222225] hover:shadow-[0_10px_32px_-14px_rgba(251,191,36,0.35)]"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700/70 bg-zinc-800/60 text-zinc-400 transition-colors group-hover:border-amber-400/30 group-hover:bg-amber-400/10 group-hover:text-amber-300">
                <s.icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-medium text-zinc-200">
                  {s.title}
                </span>
                <span className="block truncate text-[12px] text-zinc-500">
                  {s.desc}
                </span>
              </span>
            </button>
          ))}
        </div>

        <p className="mt-7 hidden items-center gap-1.5 text-[11.5px] text-zinc-600 sm:flex">
          Press
          <kbd className="rounded border border-zinc-700 bg-zinc-800/70 px-1.5 py-0.5 font-sans text-[10px] font-medium text-zinc-400">
            ⌘K
          </kbd>
          to search every message, model &amp; action
        </p>
      </div>
    </div>
  );
}
