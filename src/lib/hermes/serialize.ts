// Hermes — safe serializers for API responses (keys never leave unmasked).

import { db } from "@/lib/db";
import { keyHealthSnapshot } from "./keyhealth";
import { limiterStatus, keyWindowUsage } from "./limiter";
import { poolKeyRecords } from "./pool";
import {
  BURST_5H_LIMIT,
  DAILY_PACE_TARGET,
  MONTHLY_POOL_PER_KEY,
} from "./constants";
import type { KeyView, ProviderView, UsageSnapshot } from "./types";

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
