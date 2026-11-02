// SenkuAPI — 3-tier pacing limiter.
// Strictly monitors every pooled key of token-limited providers:
//   Tier 1  Monthly Pool  — 500,000 tokens / key / month
//   Tier 2  Daily Pace    — monthly pool ÷ 30 per usage day
//                           (usage day = 01:00 → 01:00, Africa/Algiers)
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

// ── Usage day (Run 14) ─────────────────────────────────────
// "Daily" means the user's billing day: 01:00 → 01:00 in
// Africa/Algiers — NOT the server's local midnight. The reset is
// COMPUTED, not scheduled: every aggregate asks "what did the
// current usage day start at?", so the counter rolls over by
// itself at 01:00 with no cron to miss or corrupt.
export const USAGE_DAY_TIMEZONE = "Africa/Algiers";
export const USAGE_DAY_START_HOUR = 1; // 01:00 local

/** Minutes the zone is offset from UTC at that instant
 *  (positive = east). Re-derived per call — survives DST rule
 *  changes, which Africa/Algiers may someday have again. */
function tzOffsetMinutes(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second")
  );
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/** The UTC instant of a wall-clock date+hour in the usage timezone
 *  (two-pass to resolve DST-edge ambiguity). */
function zonedInstant(
  y: number,
  m: number,
  d: number,
  hour: number
): Date {
  const guess = Date.UTC(y, m - 1, d, hour, 0, 0);
  const first = guess - tzOffsetMinutes(new Date(guess), USAGE_DAY_TIMEZONE) * 60000;
  const second = guess - tzOffsetMinutes(new Date(first), USAGE_DAY_TIMEZONE) * 60000;
  return new Date(second);
}

/** Algiers Y/M/D + hour for an instant. */
function usageZoneParts(instant: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: USAGE_DAY_TIMEZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    y: get("year"),
    m: get("month"),
    d: get("day"),
    hour: get("hour") % 24,
  };
}

function shiftDay(y: number, m: number, d: number, delta: number) {
  const shifted = new Date(Date.UTC(y, m - 1, d + delta));
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  };
}

/** Start of the usage day containing `now`: 01:00 Africa/Algiers.
 *  Between 00:00 and 00:59 the usage day still "belongs" to the
 *  previous evening — it started yesterday at 01:00. */
export function usageDayStart(now = new Date()): Date {
  const { y, m, d, hour } = usageZoneParts(now);
  const day = hour < USAGE_DAY_START_HOUR ? shiftDay(y, m, d, -1) : { y, m, d };
  return zonedInstant(day.y, day.m, day.d, USAGE_DAY_START_HOUR);
}

/** Next instant the daily counter rolls over (the coming 01:00). */
export function nextUsageDayRollover(now = new Date()): Date {
  const { y, m, d, hour } = usageZoneParts(now);
  const day = hour < USAGE_DAY_START_HOUR ? { y, m, d } : shiftDay(y, m, d, 1);
  return zonedInstant(day.y, day.m, day.d, USAGE_DAY_START_HOUR);
}

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
      where: { keyId, createdAt: { gte: usageDayStart() } },
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

  // ── Run 14: daily (01:00 → 01:00) + gateway-wide all-time ──
  // The DISPLAYED daily counter counts everything through this
  // provider since the usage day began — including cloud-failover
  // turns (keyId: null) the per-key tier math above skips.
  const dailyAgg = await db.usageEvent.aggregate({
    _sum: { totalTokens: true },
    where: { providerId: provider.id, createdAt: { gte: usageDayStart() } },
  });
  const dailyTokens = Math.round(
    (dailyAgg._sum.totalTokens ?? 0) * provider.tokenMultiplier
  );
  const dailyResetsAt = nextUsageDayRollover().toISOString();
  const [allProviders, groupedByProvider] = await Promise.all([
    db.provider.findMany({ select: { id: true, tokenMultiplier: true } }),
    db.usageEvent.groupBy({ by: ["providerId"], _sum: { totalTokens: true } }),
  ]);
  const allTimeTokens = groupedByProvider.reduce((acc, g) => {
    const mult =
      allProviders.find((p) => p.id === g.providerId)?.tokenMultiplier ?? 1;
    return acc + Math.round((g._sum.totalTokens ?? 0) * mult);
  }, 0);

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
    dailyTokens,
    dailyResetsAt,
    allTimeTokens,
    activeKeys: keys.length,
  };
}
