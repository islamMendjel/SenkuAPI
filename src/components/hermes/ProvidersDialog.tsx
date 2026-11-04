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
import {
  Check,
  Clapperboard,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
  Zap,
} from "lucide-react";
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
import type {
  KeyView,
  ProviderView,
  RehearsalStep,
} from "@/lib/hermes/types";

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

// Run 41 — THE LIVING POOL: one honest phrase per key, built from
// the prober's own records. Spoken by tooltips and screen readers
// alike — the state, the evidence (latency / error), and the
// per-boot serve ledger.
function livePhrase(k: KeyView): string {
  const live = k.live;
  if (!live) return "";
  const s =
    live.state === "serving"
      ? `probe-verified live${live.lastLatencyMs != null ? ` · ${live.lastLatencyMs}ms probe` : ""}`
      : live.state === "checkin"
        ? "needs its daily dashboard check-in (402) — it rejoins the pool automatically once checked in"
        : live.state === "cooling"
          ? live.lastProbeStatus === 401 || live.lastProbeStatus === 403
            ? "credential rejected (suspended or rotated) — replace the key; auto re-probed every 10 min"
            : "breaker cooldown"
          : live.state === "down"
            ? `not responding${live.lastError ? ` (${live.lastError})` : ""}`
            : "awaiting first probe";
  const serves =
    live.serves > 0
      ? ` · ${live.serves} serve${live.serves === 1 ? "" : "s"} this boot`
      : "";
  return ` · ${s}${serves}`;
}

const TIER_TAG: Record<string, string> = {
  monthly: "mo cap",
  daily: "day cap",
  burst5h: "5h cap",
};

/** Run 42 — verdict of one manual liveness probe. */
interface ProbeVerdict {
  ok: boolean;
  status: number;
  latencyMs: number;
  error: string | null;
}

/** True when no active key has any month-to-date spend yet — the
 *  fairness readout's honest "nothing to weigh" state. */
function maxSpendIsZero(keys: KeyView[]): boolean {
  return !keys.some((k) => k.isActive && k.tokensUsedThisMonth > 0);
}

// ── Run 43 — THE RING REHEARSAL (playback) ────────────────────
// The server dry-ran the real pick logic N turns and restored the
// cursor; what arrives here is a walk trace the ring REPLAYS:
// every skipped seat flashes rose with its reason, every serve
// lands amber. Fairness stops being a percentage and becomes
// something you watch.
interface RehEntry {
  seat: number;
  kind: "skip" | "serve";
  turn: number;
  label: string;
  why: string; // skip reason — tier tag or "cooling"
}

interface RehPlayback {
  timeline: RehEntry[];
  turns: number; // turns actually walked (may stop early on a stall)
  requested: number;
  idx: number; // entry currently lit
  done: boolean;
  stalled: boolean;
}

function flattenRehearsal(steps: RehearsalStep[]): {
  timeline: RehEntry[];
  stalled: boolean;
} {
  const timeline: RehEntry[] = [];
  let stalled = false;
  for (const step of steps) {
    for (const v of step.walk) {
      timeline.push({
        seat: v.seat,
        kind: v.allowed ? "serve" : "skip",
        turn: step.turn,
        label: v.label,
        why: !v.allowed
          ? v.blockedTier
            ? TIER_TAG[v.blockedTier]
            : v.cooling
              ? "cooling"
              : "blocked"
          : "",
      });
    }
    if (!step.served) stalled = true;
  }
  return { timeline, stalled };
}

function Orrery({ provider, now }: { provider: ProviderView; now: number }) {
  const keys = provider.keys;
  const n = keys.length;
  const { rehearseRing } = useHermes();
  const { toast } = useToast();

  // Run 43 — rehearsal playback: local to the dialog, mutating
  // nothing. The stepper lights one timeline entry at a time —
  // serves linger a beat longer than skips so the eye reads the
  // rhythm of the ring.
  const [reh, setReh] = useState<RehPlayback | null>(null);
  const [rehBusy, setRehBusy] = useState(false);

  useEffect(() => {
    if (!reh || reh.done || reh.idx < 0) return;
    if (reh.idx >= reh.timeline.length) {
      const t = setTimeout(
        () => setReh((r) => (r ? { ...r, done: true } : r)),
        450
      );
      return () => clearTimeout(t);
    }
    const cur = reh.timeline[reh.idx];
    const t = setTimeout(
      () => setReh((r) => (r ? { ...r, idx: r.idx + 1 } : r)),
      cur?.kind === "serve" ? 700 : 430
    );
    return () => clearTimeout(t);
  }, [reh]);

  const doRehearse = async () => {
    if (rehBusy || (reh !== null && !reh.done)) return;
    setRehBusy(true);
    setReh(null);
    try {
      const r = await rehearseRing(10);
      const { timeline, stalled } = flattenRehearsal(r.steps);
      setReh({
        timeline,
        turns: r.steps.length,
        requested: 10,
        idx: timeline.length ? 0 : -1,
        done: timeline.length === 0,
        stalled,
      });
    } catch (e) {
      toast({
        description:
          (e as Error).message ||
          "Rehearsal failed — the live ring is untouched.",
        variant: "destructive",
      });
    } finally {
      setRehBusy(false);
    }
  };

  const rehPlaying = reh !== null && !reh.done && reh.idx >= 0;
  const rehCur =
    rehPlaying && reh.idx < reh.timeline.length
      ? reh.timeline[reh.idx]
      : null;
  // The serves that have landed so far — the accumulating proof.
  const rehServes = useMemo(() => {
    if (!reh) return [];
    const upto = reh.done ? reh.timeline.length : reh.idx + 1;
    return reh.timeline.slice(0, upto).filter((e) => e.kind === "serve");
  }, [reh]);
  const rehCounts = useMemo(() => {
    // Fairness counts per SEAT, not per label: labels are owner-
    // chosen and can repeat (two "Pool key #3"s are different keys),
    // but the ring's promise is seat-even. Chips above keep labels;
    // this line is the arithmetic.
    const m = new Map<number, number>();
    for (const e of rehServes) m.set(e.seat, (m.get(e.seat) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [rehServes]);

  // Run 42 — the "next" badge is SERVER TRUTH: predictedNextId is
  // computed by the serialize layer from the same inputs pickKey
  // uses (key-anchored cursor, breaker, pacing tiers, drift-repair
  // bias). The UI marks the seat and invents nothing — prediction
  // and dispatch can never disagree.
  const predictedNextId = provider.predictedNextId ?? null;
  const predictedNext = predictedNextId
    ? (keys.find((k) => k.id === predictedNextId) ?? null)
    : null;
  const predictedNextSeat = predictedNext?.seat ?? null;

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
            src="/senku-sparkle.png"
            alt="Senku"
            width={562}
            height={563}
            className="hermes-pulse h-14 w-14 object-contain object-center drop-shadow-[0_0_10px_rgba(252,211,77,0.35)]"
            priority
          />
          <p className="mt-1 max-w-[130px] truncate text-center text-[10.5px] font-medium text-amber-200/90">
            {rehCur
              ? `rehearsal · turn ${rehCur.turn}/${reh?.turns ?? 0}`
              : predictedNext
                ? `next · ${predictedNext.label}`
                : "pool idle"}
          </p>
        </div>

        {/* seats */}
        {keys.map((k) => {
          const seat = k.seat ?? keys.indexOf(k);
          const angle = (-90 + (seat * 360) / n) * (Math.PI / 180);
          const left = 50 + radius * Math.cos(angle);
          const top = 50 + radius * Math.sin(angle);
          const isNext = predictedNextId === k.id;
          const cooling = cooldownLeft(k.coolingUntil, now);
          const blocked = k.blockedTier ?? null;
          const live = k.live ?? null;

          // Run 41 — the seat tells the key's REAL story: amber pulse
          // = waiting on the owner's daily check-in (it self-heals
          // the moment the dashboard check-in lands — the prober
          // revives it, no restart needed); rose = breaker/down;
          // emerald = probe-verified live right now.
          let ringCls = "border-zinc-600 bg-[#232326] text-zinc-300";
          let tag: { text: string; cls: string } | null = null;
          let pulseSeat = false;
          if (!k.isActive) {
            ringCls = "border-zinc-700/60 bg-[#1a1a1c] text-zinc-600";
            tag = { text: "off", cls: "text-zinc-500" };
          } else if (live?.state === "checkin") {
            ringCls =
              "border-amber-400/70 bg-amber-400/10 text-amber-200";
            tag = { text: "check-in", cls: "text-amber-300/90" };
            pulseSeat = true;
          } else if (cooling !== null) {
            // A credential rejection (401/403 — suspended or rotated)
            // is NOT a cooldown the key will outlive: the tag says
            // "rejected" instead of a countdown that implies return.
            if (live?.lastProbeStatus === 401 || live?.lastProbeStatus === 403) {
              ringCls =
                "border-rose-500/50 bg-rose-500/[0.08] text-rose-300";
              tag = { text: "rejected", cls: "text-rose-300/90" };
            } else {
              ringCls =
                "border-rose-400/60 bg-rose-400/10 text-rose-300";
              tag = { text: fmtCountdown(cooling), cls: "text-rose-300/90" };
            }
          } else if (live?.state === "down") {
            ringCls =
              "border-rose-500/40 bg-rose-500/[0.07] text-rose-300/90";
            tag = { text: "down", cls: "text-rose-300/80" };
          } else if (blocked) {
            ringCls =
              "border-amber-400/40 bg-amber-400/[0.07] text-amber-200/80";
            tag = { text: TIER_TAG[blocked], cls: "text-amber-200/70" };
          } else if (isNext) {
            ringCls =
              "border-amber-300 bg-amber-300/15 text-amber-100 shadow-[0_0_18px_rgba(252,211,77,0.35)]";
            // NEXT on a probe-verified key keeps its evidence tag —
            // the ring can say "next" AND "412ms live" at once.
            if (live?.state === "serving" && live.lastLatencyMs != null) {
              tag = { text: `${live.lastLatencyMs}ms`, cls: "text-emerald-300/80" };
            }
          } else if (live?.state === "serving") {
            ringCls =
              "border-emerald-500/45 bg-emerald-500/[0.07] text-emerald-200";
            tag =
              live.lastLatencyMs != null
                ? { text: `${live.lastLatencyMs}ms`, cls: "text-emerald-300/80" }
                : { text: "live", cls: "text-emerald-300/80" };
          } else if (live?.state === "unproven") {
            tag = { text: "probing…", cls: "text-zinc-500" };
          }

          // Run 43 — the rehearsal ghost overrides the seat's look
          // while it passes through: serves land amber and linger,
          // skips flash rose with the reason they were passed over.
          const rehHere = rehCur && rehCur.seat === seat ? rehCur : null;
          if (rehHere?.kind === "serve") {
            ringCls =
              "border-amber-300 bg-amber-300/30 text-amber-50 shadow-[0_0_26px_rgba(252,211,77,0.6)]";
            tag = { text: "serve", cls: "text-amber-200" };
          } else if (rehHere) {
            ringCls = "border-rose-400 bg-rose-400/25 text-rose-100";
            tag = { text: rehHere.why || "skip", cls: "text-rose-200" };
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
              title={`${k.label} · ${k.masked}${livePhrase(k)}${k.lastUsedAt ? ` · last served ${new Date(k.lastUsedAt).toLocaleDateString()}` : " · never served"}`}
            >
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-full border font-mono text-[12px] font-semibold transition-all duration-500 ${ringCls} ${
                  isNext ? "scale-110" : ""
                } ${pulseSeat ? "animate-pulse" : ""}`}
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

      {/* Run 41/42 — the pool line tells the SERVING truth and the
          FAIRNESS truth: "2 of 4 keys serving · balancing ±18%" —
          both numbers computed server-side from the same inputs the
          gateway dispatches with. The dot pulses amber while drift
          repair is actively steering the ring. */}
      {(() => {
        const activeCount = keys.filter((k) => k.isActive).length;
        const serving = keys.filter(
          (k) => k.isActive && k.live?.state === "serving"
        ).length;
        const allLive = activeCount > 0 && serving === activeCount;
        const balancing = provider.balancing ?? false;
        const driftPct = provider.driftPct ?? 0;
        const fairnessLabel = balancing
          ? `balancing · evening ±${Math.round(driftPct * 100)}% spend`
          : maxSpendIsZero(keys)
            ? "no spend yet"
            : driftPct <= 0.15
              ? "rotation even"
              : `drift ±${Math.round(driftPct * 100)}%`;
        return (
          <p
            className="mt-4 flex items-center justify-center gap-1.5 pb-1.5 text-[11px] text-zinc-500"
            title={`${serving} of ${activeCount} active keys are probe-verified live right now (background prober, 30s cadence). Month-to-date spend spread across the ready pool — when it exceeds 12%, the ring starts each scan at the least-spent key until the pools are even again, so monthly capacity is never left stranded on a capped key.`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                balancing
                  ? "bg-amber-400 animate-pulse"
                  : allLive
                    ? "bg-emerald-400"
                    : "bg-amber-400"
              }`}
              aria-hidden
            />
            {serving} of {activeCount} keys serving ·{" "}
            <span
              className={
                balancing
                  ? "text-amber-300/90"
                  : fairnessLabel === "rotation even" || fairnessLabel === "no spend yet"
                    ? "text-emerald-300/90"
                    : "text-amber-300/90"
              }
            >
              {fairnessLabel}
            </span>
          </p>
        );
      })()}

      {/* Run 43 — THE RING REHEARSAL: dry-run the rotation 10 turns
          into the future against the REAL pick logic — breaker,
          pacing caps, drift repair — and watch it walk the ring.
          The server restores the live cursor before responding, so
          this is pure foresight: fairness you can SEE, and a debug
          oracle for "why does that seat never serve?" */}
      <div className="mt-2 flex items-center justify-center">
        <button
          onClick={() => void doRehearse()}
          disabled={rehBusy || (reh !== null && !reh.done)}
          title="Dry-run the next 10 picks against the real rotation logic — breaker skips, pacing caps, drift repair — without moving the live cursor."
          className="flex items-center gap-1.5 rounded-full border border-zinc-700 bg-[#232326] px-3 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-white/5 hover:text-white disabled:opacity-50"
        >
          {rehBusy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Clapperboard className="h-3 w-3" />
          )}
          {rehBusy
            ? "rehearsing…"
            : reh?.done
              ? "rehearse again"
              : "rehearse 10 turns"}
        </button>
      </div>

      {reh && (
        <div
          className="mt-2.5 rounded-xl border border-zinc-800/80 bg-[#18181b] px-3 py-2.5"
          aria-live="polite"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              {reh.done ? "rehearsal · dry run" : "rehearsing…"}
            </p>
            <p className="font-mono text-[10px] tabular-nums text-zinc-600">
              {reh.done
                ? reh.stalled
                  ? `stalled at turn ${reh.turns} of ${reh.requested}`
                  : `${reh.turns} turns`
                : `turn ${Math.min(rehCur?.turn ?? 1, reh.turns)}/${reh.turns}`}
            </p>
          </div>
          {/* the walk, one chip per visit: amber lands, rose skips */}
          <div className="mt-1.5 flex max-h-20 flex-wrap items-center gap-1 overflow-y-auto">
            {(reh.done
              ? reh.timeline
              : reh.timeline.slice(0, reh.idx + 1)
            ).map((e, i) =>
              e.kind === "serve" ? (
                <span
                  key={i}
                  className="rounded-md bg-amber-300/10 px-1.5 py-0.5 font-mono text-[9.5px] text-amber-200/90"
                >
                  №{e.seat + 1} {e.label}
                </span>
              ) : (
                <span
                  key={i}
                  title={`seat ${e.seat + 1} skipped — ${e.why}`}
                  className="rounded-md border border-rose-400/25 px-1 py-0.5 font-mono text-[9px] text-rose-300/60"
                >
                  ↷{e.why}
                </span>
              )
            )}
            {rehServes.length === 0 && (
              <span className="text-[10px] text-zinc-600">—</span>
            )}
          </div>
          <p className="mt-1.5 text-[10px] leading-snug text-zinc-500">
            {reh.done
              ? reh.stalled
                ? "Every seat is cooling or capped — nothing serves until a window resets. The live ring was never touched."
                : `${rehCounts.map(([s, c]) => `№${s + 1} ×${c}`).join(" · ")} — live cursor untouched, next pick unchanged.`
              : "dry run — the live cursor never moves"}
          </p>
          {reh.done && !reh.stalled && (
            <span className="sr-only">
              Rehearsal dry run complete: {reh.turns} turns rehearsed,
              distribution{" "}
              {rehCounts.map(([s, c]) => `seat ${s + 1} served ${c}`).join(", ")}. The
              live rotation was not affected.
            </span>
          )}
        </div>
      )}

      {/* Run 42 — THE RING LEDGER: the ring's heartbeat. The last
          confirmed serves replay here as real traffic flows, so the
          rotation is something you SEE, not something you trust. */}
      {provider.ringEvents && provider.ringEvents.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {provider.ringEvents.slice(0, 3).map((e) => (
            <p
              key={`${e.at}-${e.keyId}`}
              className="flex items-center justify-center gap-1.5 text-center font-mono text-[10px] tabular-nums text-zinc-600"
            >
              <span className="text-zinc-700">served</span>
              <span className="text-zinc-500">№{e.seat + 1}</span>
              <span className="max-w-[96px] truncate text-zinc-500">{e.label}</span>
              <span>· {formatCompact(e.tokens)} tok</span>
              <span>
                ·{" "}
                {new Date(e.at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
            </p>
          ))}
        </div>
      )}
      <span className="sr-only">
        Round-robin ring: seat {(predictedNextSeat ?? 0) + 1} of {n} serves next
        {provider.balancing
          ? `, drift repair active (±${Math.round((provider.driftPct ?? 0) * 100)}% spend spread) — the least-spent key serves until pools are even`
          : ""}
        .
        {keys
          .map(
            (k) =>
              `Seat ${(k.seat ?? 0) + 1} ${k.label}: ${
                k.isActive ? "active" : "off"
              }${livePhrase(k)}${k.coolingUntil ? ", cooling down" : ""}${
                k.blockedTier ? `, blocked by ${k.blockedTier} tier` : ""
              }.`
          )
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
  const { addKey, deleteKey, toggleKey, probeKey } = useHermes();
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
          <KeyRow
            key={k.id}
            k={k}
            now={now}
            onDelete={deleteKey}
            onToggle={toggleKey}
            onProbe={probeKey}
          />
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
  onProbe,
}: {
  k: KeyView;
  now: number;
  onDelete: (id: string) => Promise<void>;
  onToggle: (id: string, isActive: boolean) => Promise<void>;
  onProbe: (id: string) => Promise<ProbeVerdict>;
}) {
  const { toast } = useToast();
  const [probing, setProbing] = useState(false);
  const cooling = cooldownLeft(k.coolingUntil, now);
  const blocked = k.blockedTier ?? null;
  const live = k.live ?? null;
  // Run 41 — the row speaks the key's live truth, with a tone per
  // verdict: amber = an owner ACTION (daily check-in), rose =
  // cooling / not responding, emerald = probe-verified serving.
  let state: string | null = null;
  let stateCls = "";
  if (!k.isActive) {
    state = "off";
  } else if (live?.state === "checkin") {
    state = "needs daily check-in — self-heals once checked in";
    stateCls = " text-amber-300/90";
  } else if (cooling !== null) {
    state =
      live?.lastProbeStatus === 401 || live?.lastProbeStatus === 403
        ? "credential rejected — replace the key"
        : `cooling ${fmtCountdown(cooling)}`;
    stateCls = " text-rose-300/80";
  } else if (live?.state === "down") {
    state = "not responding";
    stateCls = " text-rose-300/80";
  } else if (blocked) {
    state = TIER_TAG[blocked];
    stateCls = " text-amber-200/70";
  } else if (live?.state === "serving") {
    state = `serving${
      live.lastLatencyMs != null ? ` · ${live.lastLatencyMs}ms probe` : ""
    }${
      live.serves > 0
        ? ` · ${live.serves} serve${live.serves === 1 ? "" : "s"} this boot`
        : ""
    }`;
    stateCls = " text-emerald-300/80";
  } else if (live?.state === "unproven") {
    state = "probing…";
    stateCls = " text-zinc-500";
  }

  // Run 42 — the probe speaks its verdict out loud: live (with the
  // latency it just measured), still check-in-blocked, credential
  // rejected, or whatever the upstream actually said. No silent
  // failures — every click lands somewhere the owner can act on.
  const handleProbe = async () => {
    setProbing(true);
    try {
      const r = await onProbe(k.id);
      if (r.ok) {
        toast({
          description: `${k.label} verified live · ${r.latencyMs}ms probe`,
        });
      } else if (r.status === 402) {
        toast({
          description:
            "Still demands its daily check-in (402). Complete it on the dashboard, then probe again.",
          variant: "destructive",
        });
      } else if (r.status === 401 || r.status === 403) {
        toast({
          description: "Credential rejected (401/403) — replace the key.",
          variant: "destructive",
        });
      } else {
        toast({
          description: `Probe failed · ${r.error || `status ${r.status}`}`,
          variant: "destructive",
        });
      }
    } catch (e) {
      toast({ description: (e as Error).message, variant: "destructive" });
    } finally {
      setProbing(false);
    }
  };
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
            <span className={stateCls}> · {state}</span>
          )}
        </p>
      </div>
      {/* Run 42 — self-service healing: one liveness probe NOW.
          After a dashboard check-in or a key swap, the owner clicks
          and watches the seat flip emerald — no waiting for the
          prober's tick or the breaker's cooldown. Amber-ring when
          the key awaits its check-in: that's the "I checked in —
          re-verify now" button. */}
      <button
        onClick={() => void handleProbe()}
        disabled={probing || !k.isActive}
        aria-label={`Probe ${k.label} now`}
        title="Probe now — verify this key is live instantly"
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-40 ${
          k.live?.state === "checkin"
            ? "border border-amber-400/40 text-amber-300 hover:bg-amber-400/10"
            : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
        }`}
      >
        {probing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Zap className="h-3.5 w-3.5" />
        )}
      </button>
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
            selected provider and deactivates all others — rotation then runs
            strictly on its keys, and spend-balanced drift repair keeps every
            monthly pool even.
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
