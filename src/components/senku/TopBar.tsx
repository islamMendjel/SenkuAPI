"use client";

// SenkuAPI — top bar: sidebar toggle (ALWAYS available — the sidebar
// can be reopened from here on every screen size), ⌘K launcher,
// "Temporary" chat toggle (explicit on/off state + "won't be saved"
// tooltip) and token pill.
// Display rule: APInex active → live usage "Tokens: X / ∞"
// (X = raw usage ×4, grows with every request, never blocks);
// OxionAI active → fractional 3-tier pool limit ("Tokens: X / Y").
//
// Run 13: the sidebar toggle also PEEKS the sidebar open on hover
// (no click needed) — the shell decides the peek/pin lifecycle,
// this component only reports cursor enter/leave and clicks.

import { Clock, EyeOff, PanelLeft, Search } from "lucide-react";
import { useSenku } from "@/lib/store";
import { formatCompact, pillLabel } from "@/lib/senku/format";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Run 18 — pre-boot the pill shows a neutral pulse skeleton, NEVER
 *  a fake "0 / 500k": before bootstrap answers the real limit isn't
 *  known, and flashing amber-zero → green-real on every reload was
 *  the last visible remnant of the entry flash. Width mirrors the
 *  settled pill so nothing shifts when the truth lands. */
function TokenPillSkeleton() {
  return (
    <span
      aria-busy="true"
      aria-label="Loading usage"
      title="Loading usage…"
      className="senku-pill-loading flex h-8 w-[148px] items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-800/40 px-3"
    >
      <span
        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-zinc-600"
        aria-hidden
      />
      <span
        className="h-2 w-[92px] animate-pulse rounded-full bg-zinc-700/70"
        aria-hidden
      />
    </span>
  );
}

export function TopBar({
  sidebarOpen,
  onToggleSidebar,
  onSidebarHoverIn,
  onSidebarHoverOut,
  onOpenLimiter,
  onOpenPalette,
}: {
  /** effective open state — pinned OR hover-peek (owned by the shell) */
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onSidebarHoverIn: () => void;
  onSidebarHoverOut: () => void;
  onOpenLimiter: () => void;
  onOpenPalette: () => void;
}) {
  const { temporary, toggleTemporary, limiter, booted } = useSenku();

  const unlimited = limiter?.unlimited ?? false;
  // Run 14: the pill's headline number is the DAILY usage — it resets
  // itself at 01:00 Africa/Algiers (server-computed window, client
  // re-pulls the instant the server says the day rolled over).
  // All-time usage lives in the tooltip and the limiter breakdown.
  const tokenPill = unlimited
    ? `Tokens: ${formatCompact(limiter?.dailyTokens ?? 0)} / ∞`
    : pillLabel(limiter?.poolUsed ?? 0, limiter?.poolLimit ?? 500_000);
  const pillTitle = unlimited
    ? `Today's usage — resets daily at 01:00 (Africa/Algiers)${
        limiter?.dailyResetsAt
          ? ` · next reset ${new Date(limiter.dailyResetsAt).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
            })}`
          : ""
      } · All time: ${formatCompact(limiter?.allTimeTokens ?? 0)}`
    : "Token limiter status";

  return (
    <header className="relative z-10 flex h-12 shrink-0 items-center justify-between gap-2 px-2 sm:px-4">
      {/* left: sidebar toggle + ⌘K launcher */}
      <div className="flex items-center gap-1">
        <button
          onClick={onToggleSidebar}
          onMouseEnter={onSidebarHoverIn}
          onMouseLeave={onSidebarHoverOut}
          aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
          aria-expanded={sidebarOpen}
          title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
        >
          <PanelLeft className="h-[18px] w-[18px]" />
        </button>
        <button
          onClick={onOpenPalette}
          aria-label="Open command palette"
          title="Command palette (⌘K)"
          className="flex h-9 items-center gap-2 rounded-lg pl-2 pr-2 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
        >
          <Search className="h-4 w-4" />
          <span className="hidden text-[13px] lg:inline">Search</span>
          <kbd className="hidden rounded border border-zinc-700 bg-zinc-800/70 px-1.5 py-0.5 font-sans text-[10px] font-medium text-zinc-400 lg:inline">
            ⌘K
          </kbd>
        </button>
      </div>

      {/* Temporary chat indicator (centered) */}
      {temporary && (
        <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-[13px] font-medium text-zinc-400">
          Temporary Chat
        </span>
      )}

      {/* right: temporary toggle + token pill */}
      <div className="flex items-center gap-2">
        {/* Temporary chat — visible on/off state; the tooltip spells
            out the consequence BEFORE the user flips the switch. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={toggleTemporary}
              aria-pressed={temporary}
              className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors ${
                temporary
                  ? "border-zinc-300 bg-white text-black hover:bg-zinc-200"
                  : "border-zinc-700 text-zinc-300 hover:bg-white/5 hover:text-white"
              }`}
            >
              {temporary ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Clock className="h-3.5 w-3.5" />
              )}
              {temporary ? "Temporary · On" : "Temporary"}
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            className="max-w-[220px] border border-zinc-700 bg-[#262627] text-center text-[12px] leading-relaxed text-zinc-300"
          >
            {temporary
              ? "Temporary chat is ON — messages won't be saved to history. Click to turn off and start a fresh saved chat."
              : "Start a temporary chat — messages won't be saved to history. Your current conversation stays in the sidebar."}
          </TooltipContent>
        </Tooltip>

        {booted ? (
          <button
            onClick={onOpenLimiter}
            className={`senku-fade-up flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors ${
              unlimited
                ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/20"
                : "border-amber-400/40 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20"
            }`}
            title={pillTitle}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                unlimited ? "bg-emerald-400" : "bg-amber-400"
              }`}
            />
            {tokenPill}
          </button>
        ) : (
          <TokenPillSkeleton />
        )}
      </div>
    </header>
  );
}
