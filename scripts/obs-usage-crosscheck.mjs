// Run 14 — independently recompute daily/all-time from the DB and
// compare against what /api/usage serves.
import { PrismaClient } from "@prisma/client";
import { usageDayStart, nextUsageDayRollover } from "../src/lib/hermes/limiter.ts";
const db = new PrismaClient();

const res = await fetch("http://localhost:3000/api/usage");
const { limiter, providers } = await res.json();

const windowStart = usageDayStart();
const multByProvider = new Map(
  (await db.provider.findMany()).map((p) => [p.id, p.tokenMultiplier])
);

const expectedDailyAgg = await db.usageEvent.aggregate({
  _sum: { totalTokens: true },
  where: { providerId: limiter.providerSlug === "apinex"
      ? (await db.provider.findFirst({ where: { slug: "apinex" } })).id
      : null,
    createdAt: { gte: windowStart } },
});
// resolve active provider properly
const activeProvider = providers.find((p) => p.isActive);
const dailyAgg = await db.usageEvent.aggregate({
  _sum: { totalTokens: true },
  where: { providerId: activeProvider.id, createdAt: { gte: windowStart } },
});
const expectedDaily = Math.round((dailyAgg._sum.totalTokens ?? 0) * (activeProvider.tokenMultiplier ?? 1));

const grouped = await db.usageEvent.groupBy({ by: ["providerId"], _sum: { totalTokens: true } });
const expectedAllTime = grouped.reduce((a, g) => a + Math.round((g._sum.totalTokens ?? 0) * (multByProvider.get(g.providerId) ?? 1)), 0);

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
};

check("served dailyTokens matches DB window sum × multiplier",
  limiter.dailyTokens === expectedDaily,
  `served ${limiter.dailyTokens} vs expected ${expectedDaily}`);
check("served allTimeTokens matches DB Σ(per-provider lifetime × mult)",
  limiter.allTimeTokens === expectedAllTime,
  `served ${limiter.allTimeTokens} vs expected ${expectedAllTime}`);
check("dailyResetsAt equals the helper's next rollover",
  limiter.dailyResetsAt === nextUsageDayRollover().toISOString(),
  limiter.dailyResetsAt);
const roll = new Date(limiter.dailyResetsAt);
check("rollover is 01:00 in Africa/Algiers",
  new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Algiers", hour: "2-digit", minute: "2-digit" }).format(roll) === "01:00",
  new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Algiers", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" }).format(roll));
check("daily ≤ all-time", limiter.dailyTokens <= limiter.allTimeTokens,
  `${limiter.dailyTokens} ≤ ${limiter.allTimeTokens}`);
console.log(`\nwindow start (UTC): ${windowStart.toISOString()}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
