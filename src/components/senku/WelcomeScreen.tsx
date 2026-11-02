"use client";

// SenkuAPI — welcome screen. Clean and focused: logo, greeting,
// live local clock and one-click starter prompts. No plan badges,
// no model pickers — the model always starts on the default (glm-5.3).

import Image from "next/image";
import {
  Code2,
  Globe,
  GraduationCap,
  ListChecks,
} from "lucide-react";
import { useSenku } from "@/lib/store";
import { useNow } from "@/hooks/use-now";
import {
  USER_TIMEZONE_LABEL,
  liveDate,
  liveTime,
} from "@/lib/senku/constants";

/** Pulsing live clock — proof the gateway answers with real "now". */
function LiveClock() {
  const now = useNow(1000);

  // Reserve one line of height before mount (no layout shift, no
  // hydration mismatch — the server never renders a clock).
  if (!now) return <div className="mt-3.5 h-5" aria-hidden />;

  return (
    <p
      className="mt-3.5 flex items-center justify-center gap-2 text-[13px] tabular-nums text-zinc-500"
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
  const { user, sendMessage, setSearchEnabled } = useSenku();

  const fire = (prompt: string, withSearch?: boolean) => {
    if (withSearch) setSearchEnabled(true);
    void sendMessage(prompt);
  };

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
        {/* logo */}
        <div className="relative mb-5">
          <div
            aria-hidden
            className="absolute inset-0 -z-10 scale-150 rounded-full bg-amber-400/10 blur-3xl"
          />
          <Image
            src="/senku-sparkle.png"
            alt="SenkuAPI logo"
            width={64}
            height={64}
            className="senku-float h-16 w-16 drop-shadow-[0_0_24px_rgba(251,191,36,0.25)]"
            priority
          />
        </div>

        <h1 className="text-[28px] font-semibold tracking-tight text-white">
          {user.name} returns!
        </h1>
        <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-zinc-400">
          Pooled key routing, prompt caching, and OpenAI compatibility. What
          can I help you with today?
        </p>

        <LiveClock />

        {/* one-click starter prompts */}
        <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
          {STARTERS.map((s) => (
            <button
              key={s.title}
              onClick={() => fire(s.prompt, s.search)}
              className="group flex items-center gap-3 rounded-xl border border-zinc-800 bg-[#1d1d20]/80 p-3.5 text-left transition-all hover:-translate-y-0.5 hover:border-amber-400/35 hover:bg-[#222225]"
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
