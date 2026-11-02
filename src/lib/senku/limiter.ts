// SenkuAPI — 3-tier pacing limiter.
// Strictly monitors every pooled key of token-limited providers:
//   Tier 1  Monthly Pool  — 500,000 tokens / key / month
//   Tier 2  Daily Pace    — monthly pool ÷ 30 per calendar day
//   Tier 3  5H Burst      — rolling 5-hour window at 2× average pace
// Unlimited providers (APInex, hasTokenLimit=false) NEVER block.

import { db } from "@/lib/db";
import {
  BURST_5H_LIMIT,
  DAILY_PACE_TARGET,
  HIGH_PACE_THRESHOLD,
  MONTHLY_POOL_PER_KEY,
} from "./constants";
import type { LimiterStatus, PaceStatus, TierInfo } from "./types";

export interface KeyWindowUsage {
  monthly: number;
  daily: number;
  burst5h: number;
}

export interface KeyCheck {
  allowed: boolean;
  unlimited: boolean;
  blockedTier: "monthly" | "daily" | "burst5h" | null;
}

function startOfMonth(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function startOfDay(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function fiveHoursAgo(d = new Date()): Date {
  return new Date(d.getTime() - 5 * 3600 * 1000);
}

/** Raw token usage for one key inside each limiter window. */
export async function keyWindowUsage(keyId: string): Promise<KeyWindowUsage> {
  const [monthly, daily, burst] = await Promise.all([
    db.usageEvent.aggregate({
      _sum: { totalTokens: true },
      where: { keyId, createdAt: { gte: startOfMonth() } },
    }),
    db.usageEvent.aggregate({
      _sum: { totalTokens: true },
      where: { keyId, createdAt: { gte: startOfDay() } },
    }),
    db.usageEvent.aggregate({
      _sum: { totalTokens: true },
      where: { keyId, createdAt: { gte: fiveHoursAgo() } },
    }),
  ]);
  return {
    monthly: monthly._sum.totalTokens ?? 0,
    daily: daily._sum.totalTokens ?? 0,
    burst5h: burst._sum.totalTokens ?? 0,
  };
}

/** Can this key still serve a request under all three tiers? */
export async function checkKey(
  key: { id: string; providerId: string },
  provider: { hasTokenLimit: boolean; tokenLimitPerKey: number }
): Promise<KeyCheck> {
  if (!provider.hasTokenLimit) {
    return { allowed: true, unlimited: true, blockedTier: null };
  }
  const usage = await keyWindowUsage(key.id);
  const monthlyLimit = provider.tokenLimitPerKey || MONTHLY_POOL_PER_KEY;
  if (usage.monthly >= monthlyLimit) {
    return { allowed: false, unlimited: false, blockedTier: "monthly" };
  }
  if (usage.daily >= DAILY_PACE_TARGET) {
    return { allowed: false, unlimited: false, blockedTier: "daily" };
  }
  if (usage.burst5h >= BURST_5H_LIMIT) {
    return { allowed: false, unlimited: false, blockedTier: "burst5h" };
  }
  return { allowed: true, unlimited: false, blockedTier: null };
}

function tier(
  key: "monthly" | "daily" | "burst5h",
  label: string,
  used: number,
  limit: number,
  unlimited: boolean
): TierInfo {
  return {
    key,
    label,
    used,
    limit,
    ratio: unlimited ? 1 : Math.min(used / limit, 1),
    unlimited,
  };
}

/** Aggregated limiter status for the UI (pill + breakdown modal). */
export async function limiterStatus(provider: {
  id: string;
  name: string;
  slug: string;
  hasTokenLimit: boolean;
  tokenLimitPerKey: number;
  tokenMultiplier: number;
}): Promise<LimiterStatus> {
  const keys = await db.apiKey.findMany({
    where: { providerId: provider.id, isActive: true },
    orderBy: { createdAt: "asc" },
  });

  const perKey = await Promise.all(
    keys.map(async (k) => ({ id: k.id, usage: await keyWindowUsage(k.id) }))
  );

  const monthly = perKey.reduce((a, k) => a + k.usage.monthly, 0);
  const daily = perKey.reduce((a, k) => a + k.usage.daily, 0);
  const burst = perKey.reduce((a, k) => a + k.usage.burst5h, 0);

  const lifetime = await db.usageEvent.aggregate({
    _sum: { totalTokens: true },
    where: { providerId: provider.id },
  });
  const totalTokens = Math.round(
    (lifetime._sum.totalTokens ?? 0) * provider.tokenMultiplier
  );

  const unlimited = !provider.hasTokenLimit;
  const monthlyLimit = provider.tokenLimitPerKey || MONTHLY_POOL_PER_KEY;

  const tiers = {
    monthly: tier(
      "monthly",
      "Monthly Pool",
      monthly,
      monthlyLimit,
      unlimited
    ),
    daily: tier("daily", "Daily Pace", daily, DAILY_PACE_TARGET, unlimited),
    burst5h: tier("burst5h", "5H Burst", burst, BURST_5H_LIMIT, unlimited),
  };

  let status: PaceStatus = "on-track";
  let statusLabel = "On Track";
  let warning: string | null = null;

  if (unlimited) {
    status = "unlimited";
    statusLabel = "Ultimate";
  } else {
    const dailyRatio = keys.length ? daily / (DAILY_PACE_TARGET * keys.length) : 0;
    const monthlyRatio = keys.length ? monthly / (monthlyLimit * keys.length) : 0;
    const burstRatio = keys.length ? burst / (BURST_5H_LIMIT * keys.length) : 0;
    const maxRatio = Math.max(dailyRatio, monthlyRatio, burstRatio);
    if (maxRatio >= 1) {
      status = "exhausted";
      statusLabel = "Exhausted";
      warning =
        "All pooled keys hit a tier ceiling. Requests are blocked until a window resets — switch provider or add keys.";
    } else if (dailyRatio >= HIGH_PACE_THRESHOLD || burstRatio >= HIGH_PACE_THRESHOLD) {
      status = "high-pace";
      statusLabel = `High Pace (>${Math.round(HIGH_PACE_THRESHOLD * 100)}%)`;
      warning = `High Pace: >${Math.round(
        HIGH_PACE_THRESHOLD * 100
      )}% of daily target consumed.`;
    } else if (maxRatio >= 0.5) {
      status = "steady";
      statusLabel = "Steady Pace";
    }
  }

  return {
    providerName: provider.name,
    providerSlug: provider.slug,
    unlimited,
    multiplier: provider.tokenMultiplier,
    status,
    statusLabel,
    warning,
    tiers,
    poolUsed: monthly,
    poolLimit: unlimited ? 0 : monthlyLimit * keys.length,
    totalTokens,
    activeKeys: keys.length,
  };
}
