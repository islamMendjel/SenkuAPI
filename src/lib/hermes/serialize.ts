// Hermes — safe serializers for API responses (keys never leave unmasked).

import { db } from "@/lib/db";
import { keyHealthSnapshot } from "./keyhealth";
import { limiterStatus, keyWindowUsage } from "./limiter";
import { poolKeyRecords } from "./pool";
import { recentRingEvents } from "./ring";
import {
  BURST_5H_LIMIT,
  DAILY_PACE_TARGET,
  MONTHLY_POOL_PER_KEY,
} from "./constants";
import type { KeyView, ProviderView, UsageSnapshot } from "./types";

// Mirrors router.ts BALANCE_DRIFT_THRESHOLD — the UI must agree with
// the gateway about when the ring is actively rebalancing.
const BALANCE_DRIFT_THRESHOLD = 0.12;

export function maskKey(key: string): string {
  if (key.length <= 10) return "•".repeat(Math.max(key.length - 2, 4));
  return `${key.slice(0, 7)}${"•".repeat(8)}${key.slice(-4)}`;
}

export async function providerView(provider: {
  id: string;
  name: string;
  slug: string;
  baseUrl: string | null;
  hasTokenLimit: boolean;
  tokenLimitPerKey: number;
  tokenMultiplier: number;
  isActive: boolean;
  models: string;
  rotationCursor?: number;
  cursorKeyId?: string | null;
}): Promise<ProviderView> {
  const keys = await db.apiKey.findMany({
    where: { providerId: provider.id },
    orderBy: { createdAt: "asc" },
  });
  const lifetime = await db.usageEvent.aggregate({
    _sum: { totalTokens: true },
    where: { providerId: provider.id },
  });

  const keyViews: KeyView[] = keys.map((k, i) => ({
    id: k.id,
    label: k.label,
    masked: maskKey(k.keyValue),
    isActive: k.isActive,
    tokensUsedThisMonth: k.tokensUsedThisMonth,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  }));

  // Run 35 — THE ORRERY: the ACTIVE provider's ring is live. Each
  // key gets its seat, its breaker cooldown (if quarantined) and
  // the pacing tier currently blocking it — derived from the same
  // window aggregates the limiter itself uses, so the ring can
  // never disagree with the gateway's actual dispatch decisions.
  // Inactive providers keep a dormant, cheap view.
  let rotationCursor: number | undefined;
  if (provider.isActive) {
    rotationCursor = provider.rotationCursor ?? 0;
    const health = keyHealthSnapshot();
    const pool = poolKeyRecords();
    const monthlyLimit =
      provider.tokenLimitPerKey || MONTHLY_POOL_PER_KEY;
    // Run 42 — month-to-date spend per key, fetched once: feeds both
    // the blocking-tier verdict and the drift-repair readout.
    const monthlySpend = new Array<number>(keys.length).fill(0);
    await Promise.all(
      keys.map(async (k, i) => {
        keyViews[i].seat = i;
        const breaker = health[k.id];
        keyViews[i].coolingUntil = breaker?.coolingUntil ?? null;
        // Run 41 — THE LIVING POOL: the key's live state merges the
        // prober's records (probe truth, serves, latency) with the
        // breaker's verdict — one honest state per seat.
        const rec = pool[k.id];
        keyViews[i].live = {
          state: breaker
            ? breaker.kind === "checkin"
              ? "checkin"
              : "cooling"
            : rec?.state ?? "unproven",
          serves: rec?.serves ?? 0,
          lastProbeAt: rec?.lastProbeAt?.toISOString() ?? null,
          lastLatencyMs: rec?.lastLatencyMs ?? null,
          lastProbeStatus: rec?.lastProbeStatus ?? null,
          lastError: rec?.lastError ?? null,
        };
        if (!provider.hasTokenLimit || !k.isActive) {
          keyViews[i].blockedTier = null;
          return;
        }
        const usage = await keyWindowUsage(k.id);
        monthlySpend[i] = usage.monthly;
        keyViews[i].blockedTier =
          usage.monthly >= monthlyLimit
            ? "monthly"
            : usage.daily >= DAILY_PACE_TARGET
              ? "daily"
              : usage.burst5h >= BURST_5H_LIMIT
                ? "burst5h"
                : null;
      })
    );

    // ── Run 42 — THE FAIR RING: server-truth ring state ─────────
    // The prediction the UI draws must be computed from the SAME
    // inputs the pick uses (anchor, breaker, tiers, drift bias) —
    // a client-side re-implementation would drift the moment the
    // gateway gains a rule the UI doesn't know. The server is the
    // only author of "next".
    const cooling = (i: number) => health[keys[i].id] !== undefined;

    // Anchor: the key-anchored cursor resolved to a seat; legacy
    // positional fallback; then 0.
    const anchorIdx = provider.cursorKeyId
      ? keys.findIndex((k) => k.id === provider.cursorKeyId)
      : -1;
    const baseSeat =
      anchorIdx >= 0
        ? anchorIdx
        : ((rotationCursor % keys.length) + keys.length) % keys.length;

    // Drift over the READY pool (active, not breaker-cooling) — the
    // exact set pickKey's balancer measures.
    const readyIdx = keys
      .map((_, i) => i)
      .filter((i) => keys[i].isActive && !cooling(i));
    const spends = readyIdx.map((i) => monthlySpend[i]);
    const maxSpend = spends.length ? Math.max(...spends) : 0;
    const minSpend = spends.length ? Math.min(...spends) : 0;
    const driftPct =
      provider.hasTokenLimit && maxSpend > 0
        ? (maxSpend - minSpend) / maxSpend
        : 0;
    const balancing =
      provider.hasTokenLimit && readyIdx.length >= 2 && driftPct > BALANCE_DRIFT_THRESHOLD;

    // Predicted next seat: drift repair starts at the least-spent
    // ready key; otherwise at the anchor. Walk the ring forward,
    // skipping seats the pick would skip (off / cooling / capped).
    let startSeat = baseSeat;
    if (balancing) {
      let minIdx = readyIdx[0];
      for (const i of readyIdx) {
        if (monthlySpend[i] < monthlySpend[minIdx]) minIdx = i;
      }
      startSeat = minIdx;
    }
    let predictedIdx = -1;
    for (let step = 0; step < keys.length; step++) {
      const i = (startSeat + step) % keys.length;
      if (
        keys[i].isActive &&
        !cooling(i) &&
        !keyViews[i].blockedTier
      ) {
        predictedIdx = i;
        break;
      }
    }
    // Every seat blocked → the start seat is still "next" (the
    // breaker probes it as a last resort).
    if (predictedIdx < 0) {
      predictedIdx = keys[keys.length - 1] ? startSeat % keys.length : -1;
    }
    const predictedNextId = predictedIdx >= 0 ? keys[predictedIdx].id : null;

    // The ring ledger: freshest serves of THIS provider's keys.
    const keyIds = new Set(keys.map((k) => k.id));
    const ringEvents = recentRingEvents()
      .filter((e) => keyIds.has(e.keyId))
      .slice(0, 4);

    return {
      id: provider.id,
      name: provider.name,
      slug: provider.slug,
      baseUrl: provider.baseUrl,
      hasTokenLimit: provider.hasTokenLimit,
      tokenLimitPerKey: provider.tokenLimitPerKey,
      tokenMultiplier: provider.tokenMultiplier,
      isActive: provider.isActive,
      models: JSON.parse(provider.models || "[]"),
      keys: keyViews,
      totalTokens: Math.round(
        (lifetime._sum.totalTokens ?? 0) * provider.tokenMultiplier
      ),
      rotationCursor,
      predictedNextId,
      balancing,
      driftPct,
      ringEvents,
    };
  }

  return {
    id: provider.id,
    name: provider.name,
    slug: provider.slug,
    baseUrl: provider.baseUrl,
    hasTokenLimit: provider.hasTokenLimit,
    tokenLimitPerKey: provider.tokenLimitPerKey,
    tokenMultiplier: provider.tokenMultiplier,
    isActive: provider.isActive,
    models: JSON.parse(provider.models || "[]"),
    keys: keyViews,
    totalTokens: Math.round(
      (lifetime._sum.totalTokens ?? 0) * provider.tokenMultiplier
    ),
    ...(rotationCursor !== undefined ? { rotationCursor } : {}),
  };
}

export async function usageSnapshot(): Promise<UsageSnapshot> {
  const providers = await db.provider.findMany({
    orderBy: { createdAt: "asc" },
  });
  const views: ProviderView[] = [];
  for (const p of providers) views.push(await providerView(p));
  const active = views.find((v) => v.isActive) ?? views[0];
  const limiter = await limiterStatus(active);
  return { activeProvider: active, providers: views, limiter };
}
