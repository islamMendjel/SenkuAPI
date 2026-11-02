"use client";

// SenkuAPI — TOKEN LIMITER breakdown modal.
// Ultimate (unlimited) providers: a single live usage counter that
// starts at 0 and grows ×4 with every request — limit is ∞, never blocks.
// Limited providers: Monthly Pool / Daily Pace / 5H Burst bars.

import { TriangleAlert } from "lucide-react";
import { useSenku } from "@/lib/store";
import { formatCompact, formatFull } from "@/lib/senku/format";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TierInfo } from "@/lib/senku/types";

function barColor(ratio: number, unlimited: boolean): string {
  if (unlimited) return "bg-emerald-400";
  if (ratio >= 1) return "bg-red-400";
  if (ratio >= 0.9) return "bg-amber-400";
  if (ratio >= 0.5) return "bg-yellow-400";
  return "bg-emerald-400";
}

function statusChipClass(status: string): string {
  switch (status) {
    case "unlimited":
      return "border-emerald-400/40 bg-emerald-400/10 text-emerald-300";
    case "high-pace":
      return "border-amber-400/40 bg-amber-400/10 text-amber-300";
    case "steady":
      return "border-yellow-400/40 bg-yellow-400/10 text-yellow-300";
    case "exhausted":
      return "border-red-400/40 bg-red-400/10 text-red-300";
    default:
      return "border-emerald-400/40 bg-emerald-400/10 text-emerald-300";
  }
}

function TierRow({ tier }: { tier: TierInfo }) {
  const value = tier.unlimited
    ? `${formatFull(tier.used)} / ∞`
    : `${formatFull(tier.used)} / ${formatCompact(tier.limit)}`;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[13px] text-zinc-300">{tier.label}</span>
        <span className="text-[13px] tabular-nums text-zinc-200">{value}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`h-full rounded-full transition-all ${barColor(
            tier.ratio,
            tier.unlimited
          )}`}
          style={{ width: `${Math.max(tier.ratio * 100, tier.used > 0 ? 4 : 0)}%` }}
        />
      </div>
    </div>
  );
}

export function TokenLimiterDialog({
  open,
  onOpenChange,
  onManageProviders,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onManageProviders: () => void;
}) {
  const { limiter } = useSenku();
  if (!limiter) return null;

  const monthlyEffective = Math.round(
    limiter.tiers.monthly.used * limiter.multiplier
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-2xl border-zinc-800 bg-[#1d1d20] p-5 text-zinc-200 sm:max-w-md">
        <DialogHeader className="space-y-1.5">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-[13px] font-semibold tracking-[0.14em] text-zinc-300">
              TOKEN LIMITER
            </DialogTitle>
            <span
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${statusChipClass(
                limiter.status
              )}`}
            >
              {limiter.statusLabel}
            </span>
          </div>
          <DialogDescription className="text-[12px] text-zinc-500">
            {limiter.providerName} ·{" "}
            {limiter.unlimited
              ? `Ultimate tier — ×${limiter.multiplier.toFixed(
                  1
                )} metering, unlimited, never blocks`
              : `${limiter.activeKeys} pooled key${limiter.activeKeys === 1 ? "" : "s"} · 3-tier pacing`}
          </DialogDescription>
        </DialogHeader>

        {limiter.unlimited ? (
          /* ── Ultimate: one live counter — starts at 0, grows ×4 ── */
          <div className="space-y-4 py-3">
            <div>
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="text-[13px] text-zinc-300">Token usage</span>
                <span className="text-[15px] font-semibold tabular-nums text-zinc-100">
                  {formatFull(limiter.totalTokens)}{" "}
                  <span className="text-[12px] font-normal text-zinc-500">
                    / ∞
                  </span>
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                <div className="h-full w-full rounded-full bg-gradient-to-r from-emerald-500/40 to-emerald-400/80" />
              </div>
            </div>

            <div className="flex items-baseline justify-between">
              <span className="text-[13px] text-zinc-300">This month</span>
              <span className="text-[13px] tabular-nums text-zinc-200">
                {formatFull(monthlyEffective)} / ∞
              </span>
            </div>

            <div className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5 text-[12px] leading-relaxed text-zinc-400">
              <span className="mt-px shrink-0 font-semibold text-emerald-300">
                ×{limiter.multiplier.toFixed(1)}
              </span>
              <span>
                metering — every request adds its tokens ×
                {limiter.multiplier.toFixed(1)} to your usage. Your Ultimate
                plan has no limit and never blocks.
              </span>
            </div>
          </div>
        ) : (
          /* ── Limited: 3-tier pacing breakdown ── */
          <div className="space-y-4 py-2">
            <TierRow tier={limiter.tiers.monthly} />
            <TierRow tier={limiter.tiers.daily} />
            <TierRow tier={limiter.tiers.burst5h} />
          </div>
        )}

        {limiter.warning && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2.5 text-[12px] leading-snug text-amber-300">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {limiter.warning}
          </div>
        )}

        <div className="flex items-center justify-between pt-1">
          <span className="text-[11px] text-zinc-600">
            Lifetime through {limiter.providerName}:{" "}
            {formatFull(limiter.totalTokens)} tokens
          </span>
          <button
            onClick={() => {
              onOpenChange(false);
              onManageProviders();
            }}
            className="text-[12px] text-zinc-300 underline underline-offset-2 transition-colors hover:text-white"
          >
            Manage Providers
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
