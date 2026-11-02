"use client";

// SenkuAPI — welcome screen. Clean and focused: logo, greeting,
// live local clock and one-click starter prompts. No plan badges —
// the model always starts on the default (glm-5.3).
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
//
// Run 20 — THE ENGINE BAY: the gateway's actual inventory — the
// model lineup — becomes a first-class hero of the entry moment.
// Real engine cards (straight from the bootstrap's activeProvider
// list, never hardcoded), one click switches the engine and the
// composer picker mirrors it via the same store field. The bay
// renders NOTHING when the lineup isn't loaded — it never fakes an
// inventory. Cascade order now follows DOM order (headline →
// subtitle → clock → stats → engines → starters).

import Image from "next/image";
import {
  Check,
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
import { modelHint, modelMeta } from "@/lib/senku/models";
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

/** Run 20 — THE ENGINE BAY: the gateway's live model lineup as
 *  one-click engine cards. Real ids from the bootstrap payload,
 *  real names/notes from the shared modelMeta table, selection
 *  mirrored with the composer picker through the same store field.
 *  Renders nothing when the lineup hasn't loaded — the bay never
 *  invents an inventory. */
function EngineBay() {
  const { models, model, setModel } = useSenku();

  if (models.length === 0) return null;

  // "all free" only prints when every engine really is free-tier.
  const allFree = models.every((m) => modelMeta(m).tier === "Free");

  return (
    <section
      aria-label="Engine lineup — pick the model your next message uses"
      className="mt-8 flex w-full max-w-4xl flex-col"
    >
      <div className="senku-fade-up mb-2.5 flex items-baseline justify-between gap-3 [animation-delay:300ms]">
        <span className="text-[11px] font-semibold tracking-[0.14em] text-zinc-500">
          THE LINEUP
        </span>
        <span className="text-[11px] text-zinc-600">
          {models.length} engine{models.length === 1 ? "" : "s"} · one gateway
          {allFree ? " · all free" : ""}
        </span>
      </div>
      {/* mobile: edge-peek snap rail (scrollbar hidden — the cut-off
          card is the affordance); sm+: even auto-fit grid */}
      <div
        role="group"
        aria-label="Available engines"
        className="senku-no-bar flex snap-x snap-proximity gap-2.5 overflow-x-auto pb-1 sm:grid sm:grid-cols-[repeat(auto-fit,minmax(160px,1fr))] sm:overflow-visible sm:pb-0"
      >
        {models.map((id, i) => {
          const meta = modelMeta(id);
          const selected = id === model;
          const hint = modelHint(meta);
          return (
            <button
              key={id}
              onClick={() => setModel(id)}
              aria-pressed={selected}
              title={
                selected
                  ? `${meta.name} — current engine`
                  : `Switch to ${meta.name}${hint ? ` (${hint})` : ""}`
              }
              style={{ "--d": `${330 + i * 55}ms` } as React.CSSProperties}
              className={`senku-fade-up flex w-[152px] shrink-0 snap-start flex-col items-start rounded-xl border p-3 text-left transition-all [animation-delay:var(--d)] sm:w-auto ${
                selected
                  ? "border-emerald-400/40 bg-emerald-400/[0.07]"
                  : "border-zinc-800 bg-[#1d1d20]/80 hover:-translate-y-0.5 hover:border-amber-400/35 hover:bg-[#222225] hover:shadow-[0_10px_32px_-14px_rgba(251,191,36,0.35)]"
              }`}
            >
              <span className="max-w-full truncate text-[13px] font-medium text-zinc-100">
                {meta.name}
              </span>
              <span className="min-h-[16px] max-w-full truncate text-[11.5px] text-zinc-500">
                {meta.note ?? "\u00A0"}
              </span>
              {/* badge row always rendered → even card heights; the
                  check lives here so a long name can never collide
                  with it */}
              <span className="mt-1.5 flex w-full items-center justify-between gap-2">
                {meta.tier ? (
                  <span className="rounded-full border border-zinc-600 bg-zinc-800/60 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-zinc-400">
                    {meta.tier}
                  </span>
                ) : (
                  <span aria-hidden />
                )}
                {selected && (
                  <Check
                    aria-hidden
                    className="senku-pop h-3.5 w-3.5 shrink-0 text-emerald-300"
                  />
                )}
              </span>
            </button>
          );
        })}
      </div>
    </section>
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

        <EngineBay />

        {/* one-click starter prompts — staggered cascade + warm glow.
            Run 20: the cascade follows DOM order — the bay lands
            first (330ms+), the starters close the sequence. */}
        <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
          {STARTERS.map((s, i) => (
            <button
              key={s.title}
              onClick={() => fire(s.prompt, s.search)}
              style={{ "--d": `${600 + i * 60}ms` } as React.CSSProperties}
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
          to search chats, models &amp; actions
        </p>
      </div>
    </div>
  );
}
