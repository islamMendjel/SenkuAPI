"use client";

// Hermes — Manage Providers dialog:
// exactly ONE provider active at a time; switching sets the selected
// provider active and all others false; round-robin runs on the
// active provider's keys. Keys can be added, toggled and removed.
//
// Run 35 — THE ORRERY: the active provider's key pool renders as a
// live radial cockpit. Every key is a seat on the ring; the golden
// cursor glow marks the seat that serves NEXT, cooldowns count down
// in real time, capped keys dim with their blocking tier, and a
// fairness readout proves the rotation stays even. The dialog polls
// /api/usage while open, so the ring visibly advances turn by turn
// as the gateway serves traffic.

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { Check, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useHermes } from "@/lib/store";
import { formatCompact, formatFull } from "@/lib/hermes/format";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import type { KeyView, ProviderView } from "@/lib/hermes/types";

// ── The Orrery ────────────────────────────────────────────────

function cooldownLeft(coolingUntil: string | null | undefined, now: number) {
  if (!coolingUntil) return null;
  const ms = new Date(coolingUntil).getTime() - now;
  return ms > 0 ? ms : null;
}

function fmtCountdown(ms: number) {
  const s = Math.ceil(ms / 1000);
  if (s >= 3600) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const TIER_TAG: Record<string, string> = {
  monthly: "mo cap",
  daily: "day cap",
  burst5h: "5h cap",
};

function Orrery({ provider, now }: { provider: ProviderView; now: number }) {
  const keys = provider.keys;
  const cursor =
    provider.rotationCursor !== undefined
      ? provider.rotationCursor
      : 0;
  const n = keys.length;

  // Predict the seat that will actually serve next: walk the ring
  // forward from the cursor, skipping off / cooling / capped keys
  // (mirrors pickKey's scan, minus the DB re-checks).
  const predicted = useMemo(() => {
    if (n === 0) return null;
    for (let i = 0; i < n; i++) {
      const seat = (cursor + i) % n;
      const k = keys.find((x) => x.seat === seat);
      if (!k) continue;
      if (!k.isActive) continue;
      if (cooldownLeft(k.coolingUntil, now) !== null) continue;
      if (k.blockedTier) continue;
      return k;
    }
    // Every seat blocked → the cursor seat is still "next" (the
    // breaker probes it as a last resort).
    return keys.find((x) => x.seat === cursor) ?? keys[0];
  }, [keys, cursor, n, now]);

  // Fairness: spread of month-to-date spend across active keys.
  const fairness = useMemo(() => {
    const active = keys.filter((k) => k.isActive);
    const spends = active.map((k) => k.tokensUsedThisMonth);
    const max = Math.max(...spends, 0);
    const min = Math.min(...spends, 0);
    if (max === 0) return { label: "no spend yet", even: true };
    const spread = (max - min) / max;
    return {
      label:
        spread <= 0.15
          ? "rotation even"
          : `drift ±${Math.round(spread * 100)}%`,
      even: spread <= 0.15,
    };
  }, [keys]);

  if (n === 0) {
    return (
      <p className="mt-3 rounded-xl border border-dashed border-zinc-800 px-3 py-4 text-center text-[12px] text-zinc-500">
        The pool is empty — add a key below to start the rotation.
      </p>
    );
  }

  const size = 232;
  // Node orbit radius MUST match the ring track: inset-[13%] →
  // track radius = (100 − 26) / 2 = 37% of the container. Seats
  // sit exactly ON the arc the eye traces.
  const radius = 37; // % of container

  return (
    <div className="mt-8" aria-label="Round-robin key pool ring">
      <div
        className="relative mx-auto"
        style={{ width: size, maxWidth: "100%", aspectRatio: "1 / 1" }}
      >
        {/* static ring track — visible at every angle so the orbit
            reads as a full circle even where the golden sweep is
            between passes */}
        <div className="absolute inset-[13%] rounded-full border border-zinc-500/60" />
        {/* rotating golden sweep — the pool is alive */}
        <div className="pointer-events-none absolute inset-[13%] rounded-full opacity-70 hermes-pulse-ring" />

        {/* the medallion at the center of the ring — gold on dark
            beats gold on gold: no amber wash, the mark carries itself */}
        <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center">
          <Image
            src="/hermes-mark.png"
            alt=""
            width={875}
            height={1124}
            className="hermes-pulse h-14 w-14 object-contain object-center drop-shadow-[0_0_10px_rgba(252,211,77,0.25)]"
            priority
          />
          <p className="mt-1 max-w-[110px] truncate text-center text-[10.5px] font-medium text-amber-200/90">
            {predicted ? `next · ${predicted.label}` : "pool idle"}
          </p>
        </div>

        {/* seats */}
        {keys.map((k) => {
          const seat = k.seat ?? keys.indexOf(k);
          const angle = (-90 + (seat * 360) / n) * (Math.PI / 180);
          const left = 50 + radius * Math.cos(angle);
          const top = 50 + radius * Math.sin(angle);
          const isNext = predicted?.id === k.id;
          const cooling = cooldownLeft(k.coolingUntil, now);
          const blocked = k.blockedTier ?? null;

          let ringCls = "border-zinc-600 bg-[#232326] text-zinc-300";
          let tag: { text: string; cls: string } | null = null;
          if (!k.isActive) {
            ringCls = "border-zinc-700/60 bg-[#1a1a1c] text-zinc-600";
            tag = { text: "off", cls: "text-zinc-500" };
          } else if (cooling !== null) {
            ringCls =
              "border-rose-400/60 bg-rose-400/10 text-rose-300";
            tag = { text: fmtCountdown(cooling), cls: "text-rose-300/90" };
          } else if (blocked) {
            ringCls =
              "border-amber-400/40 bg-amber-400/[0.07] text-amber-200/80";
            tag = { text: TIER_TAG[blocked], cls: "text-amber-200/70" };
          } else if (isNext) {
            ringCls =
              "border-amber-300 bg-amber-300/15 text-amber-100 shadow-[0_0_18px_rgba(252,211,77,0.35)]";
          }

          return (
            <div
              key={k.id}
              className="absolute flex flex-col items-center"
              style={{
                left: `${left}%`,
                top: `${top}%`,
                transform: "translate(-50%, -50%)",
              }}
              title={`${k.label} · ${k.masked}${k.lastUsedAt ? ` · last served ${new Date(k.lastUsedAt).toLocaleDateString()}` : " · never served"}`}
            >
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-full border font-mono text-[12px] font-semibold transition-all duration-500 ${ringCls} ${
                  isNext ? "scale-110" : ""
                }`}
              >
                {seat + 1}
              </div>
              {isNext && (
                <span className="absolute -top-[23px] rounded-full bg-amber-300 px-1.5 py-px text-[8.5px] font-bold uppercase tracking-wider text-black shadow-sm">
                  next
                </span>
              )}
              {tag && (
                <span
                  className={`mt-1 max-w-[64px] truncate text-center text-[9px] font-medium tabular-nums ${tag.cls}`}
                >
                  {tag.text}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <p
        className="mt-4 flex items-center justify-center gap-1.5 pb-1.5 text-[11px] text-zinc-500"
        title="Spread of month-to-date spend across the pool's active keys. The perfected rotation advances one seat per served request, so this evens out as traffic flows."
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${fairness.even ? "bg-emerald-400" : "bg-amber-400"}`}
          aria-hidden
        />
        {keys.filter((k) => k.isActive).length} keys in rotation ·{" "}
        <span className={fairness.even ? "text-emerald-300/90" : "text-amber-300/90"}>
          {fairness.label}
        </span>
      </p>
      <span className="sr-only">
        Round-robin ring: seat {cursor + 1} of {n} serves next.
        {keys
          .map((k) => `Seat ${(k.seat ?? 0) + 1} ${k.label}: ${k.isActive ? "active" : "off"}${k.coolingUntil ? ", cooling down" : ""}${k.blockedTier ? `, blocked by ${k.blockedTier} tier` : ""}.`)
          .join(" ")}
      </span>
    </div>
  );
}

// ── Provider card ─────────────────────────────────────────────

function ProviderCard({
  provider,
  onSwitch,
  now,
}: {
  provider: ProviderView;
  onSwitch: (id: string) => Promise<void>;
  now: number;
}) {
  const { addKey, deleteKey, toggleKey } = useHermes();
  const { toast } = useToast();
  const [switching, setSwitching] = useState(false);
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [adding, setAdding] = useState(false);

  const doSwitch = async () => {
    setSwitching(true);
    try {
      await onSwitch(provider.id);
      toast({
        description: `${provider.name} is now the active provider.`,
      });
    } catch (e) {
      toast({ description: (e as Error).message, variant: "destructive" });
    } finally {
      setSwitching(false);
    }
  };

  const doAddKey = async () => {
    if (!key.trim()) return;
    setAdding(true);
    try {
      await addKey(provider.id, label.trim(), key.trim());
      setLabel("");
      setKey("");
      toast({ description: "Key added to the pool." });
    } catch (e) {
      toast({ description: (e as Error).message, variant: "destructive" });
    } finally {
      setAdding(false);
    }
  };

  return (
    <div
      className={`min-w-0 rounded-xl border p-3.5 transition-colors ${
        provider.isActive
          ? "border-emerald-500/40 bg-emerald-500/[0.04]"
          : "border-zinc-800 bg-[#1d1d20]"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-2 text-[14px] font-semibold text-white">
          {provider.isActive && (
            <span className="hermes-pulse h-2 w-2 rounded-full bg-emerald-400" />
          )}
          {provider.name}
        </span>
        <span className="rounded-full bg-zinc-800/80 px-2 py-0.5 text-[10.5px] font-medium text-zinc-300">
          {provider.hasTokenLimit
            ? `${formatCompact(provider.tokenLimitPerKey)} tokens / key / mo`
            : "Unlimited"}
        </span>
        <span className="rounded-full bg-zinc-800/80 px-2 py-0.5 text-[10.5px] font-medium text-zinc-300">
          ×{provider.tokenMultiplier.toFixed(1)} multiplier
        </span>
        <span className="ml-auto">
          {provider.isActive ? (
            <span className="flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 text-[12px] font-medium text-emerald-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              Active
            </span>
          ) : (
            <button
              onClick={doSwitch}
              disabled={switching}
              className="flex items-center gap-1.5 rounded-full bg-white px-3.5 py-1 text-[12px] font-medium text-black transition-colors hover:bg-zinc-200 disabled:opacity-60"
            >
              {switching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Switch
            </button>
          )}
        </span>
      </div>

      <p className="mt-1.5 truncate font-mono text-[11px] text-zinc-500">
        {provider.baseUrl ?? "no base URL"} · {provider.models.length} models ·{" "}
        {formatFull(provider.totalTokens)} lifetime tokens
      </p>

      {/* Run 35 — the live ring: only the ACTIVE provider rotates. */}
      {provider.isActive && <Orrery provider={provider} now={now} />}

      {/* keys */}
      <div className="mt-3 space-y-1.5">
        {provider.keys.map((k) => (
          <KeyRow key={k.id} k={k} now={now} onDelete={deleteKey} onToggle={toggleKey} />
        ))}

        <div className="flex gap-2">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional)"
            className="h-8 w-28 shrink-0 rounded-lg border-zinc-800 bg-[#18181b] text-[12px] text-zinc-200 placeholder:text-zinc-600 focus-visible:ring-zinc-600 sm:w-32"
          />
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Paste API key…"
            className="h-8 min-w-0 flex-1 rounded-lg border-zinc-800 bg-[#18181b] font-mono text-[12px] text-zinc-200 placeholder:text-zinc-600 focus-visible:ring-zinc-600"
            onKeyDown={(e) => {
              if (e.key === "Enter") void doAddKey();
            }}
          />
          <button
            onClick={doAddKey}
            disabled={adding || !key.trim()}
            aria-label="Add key"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-700 text-zinc-300 transition-colors hover:bg-white/5 disabled:opacity-40"
          >
            {adding ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function KeyRow({
  k,
  now,
  onDelete,
  onToggle,
}: {
  k: KeyView;
  now: number;
  onDelete: (id: string) => Promise<void>;
  onToggle: (id: string, isActive: boolean) => Promise<void>;
}) {
  const cooling = cooldownLeft(k.coolingUntil, now);
  const blocked = k.blockedTier ?? null;
  const state =
    !k.isActive
      ? "off"
      : cooling !== null
        ? `cooling ${fmtCountdown(cooling)}`
        : blocked
          ? TIER_TAG[blocked]
          : null;
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-zinc-800/80 bg-[#18181b] px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[12px] text-zinc-300">
          {k.masked}
        </p>
        <p className="text-[10.5px] text-zinc-600">
          {k.label} · {formatFull(k.tokensUsedThisMonth)} tokens this month
          {k.lastUsedAt
            ? ` · used ${new Date(k.lastUsedAt).toLocaleDateString()}`
            : " · never used"}
          {state && (
            <span
              className={
                cooling !== null
                  ? " text-rose-300/80"
                  : blocked
                    ? " text-amber-200/70"
                    : ""
              }
            >
              {" "}
              · {state}
            </span>
          )}
        </p>
      </div>
      <Switch
        checked={k.isActive}
        onCheckedChange={(v) => void onToggle(k.id, v)}
        aria-label={`Toggle key ${k.label}`}
      />
      <button
        onClick={() => void onDelete(k.id)}
        aria-label={`Delete key ${k.label}`}
        className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-red-400/10 hover:text-red-400"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ── Dialog ────────────────────────────────────────────────────

export function ProvidersDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { providers, switchProvider, refreshUsage } = useHermes();
  // Live ring: while the dialog is open, poll the store's own
  // /api/usage refresh so the orrery advances in real time as the
  // gateway serves turns. User mutations (switch/add/toggle/delete)
  // already write through the same store — one source of truth,
  // zero staleness windows.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const tick = () => setNow(Date.now());
    const poll = () => {
      if (alive) void refreshUsage();
    };
    poll();
    const poller = setInterval(poll, 4000);
    const ticker = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(poller);
      clearInterval(ticker);
    };
  }, [open, refreshUsage]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-2xl border-zinc-800 bg-[#212121] p-5 text-zinc-200 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-semibold text-white">
            Manage Providers
          </DialogTitle>
          <DialogDescription className="text-[12.5px] leading-snug text-zinc-500">
            Exactly one provider is active at a time. Switching activates the
            selected provider and deactivates all others — round-robin key
            rotation then runs strictly on its keys.
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-3 pt-1">
          {/* Run 35 — the ACTIVE provider leads: its live ring is
              the first thing the eye lands on when the dialog opens. */}
          {[...providers]
            .sort((a, b) => Number(b.isActive) - Number(a.isActive))
            .map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                onSwitch={switchProvider}
                now={now}
              />
            ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
