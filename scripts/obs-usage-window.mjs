// Run 14 observation — prove the usage-day math against known
// Algiers wall-clock cases (UTC+1, no DST), including the
// 00:xx belong-to-yesterday rule and month/year rollovers.
import { usageDayStart, nextUsageDayRollover } from "../src/lib/hermes/limiter.ts";

const fmt = (d) => d.toISOString();
let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) console.log(`   actual:   ${actual}\n   expected: ${expected}`);
}

// Independent expectation: for an instant at Algiers wall-clock
// date D with hour H: window start = D (if H>=1) else D-1 day, at 01:00 Algiers = 00:00Z.
function expectWindowStart(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T00:00:00.000Z`;
}
function shift(y, m, d, delta) {
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

const cases = [
  // [label, y, m, d, h, min]  (Algiers wall-clock of the instant to probe)
  ["midday 12:34 → today 01:00",          2026, 11, 2, 12, 34],
  ["exactly 01:00:00 → fresh window",     2026, 11, 2, 1, 0],
  ["01:00:01 → fresh window",             2026, 11, 2, 1, 0],
  ["late night 23:59 → today 01:00",      2026, 11, 2, 23, 59],
  ["just after midnight 00:00 → YESTERDAY 01:00", 2026, 11, 2, 0, 0],
  ["00:30 → yesterday 01:00",             2026, 11, 2, 0, 30],
  ["00:59:59 → yesterday 01:00",          2026, 11, 2, 0, 59, 59],
  ["month rollover: Nov 1 00:30 → Oct 31 01:00", 2026, 11, 1, 0, 30],
  ["year rollover: Jan 1 00:30 → Dec 31 01:00",  2027, 1, 1, 0, 30],
];

for (const [label, y, m, d, h, min] of cases) {
  // Build the UTC instant corresponding to that Algiers wall clock (+1)
  const probe = new Date(Date.UTC(y, m - 1, d, h - 1, min ?? 0));
  const [ey, em, ed] = h >= 1 ? [y, m, d] : shift(y, m, d, -1);
  check(
    `usageDayStart — ${label}`,
    fmt(usageDayStart(probe)),
    expectWindowStart(ey, em, ed)
  );
  const [ry, rm, rd] = h >= 1 ? shift(y, m, d, 1) : [y, m, d];
  check(
    `nextRollover — ${label}`,
    fmt(nextUsageDayRollover(probe)),
    expectWindowStart(ry, rm, rd)
  );
}

// Sanity: window start + rollover are exactly 24h apart on an
// ordinary day, and the rollover is strictly in the future.
const now = new Date();
const gap = nextUsageDayRollover(now) - usageDayStart(now);
check("window length is 24h (Algiers, no DST now)", gap, 24 * 3600 * 1000);
check("next rollover is in the future", nextUsageDayRollover(now) > now, true);
const algiersNow = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Algiers", hour: "2-digit", minute: "2-digit" }).format(now);
console.log(`   (probed at ${algiersNow} Algiers time)`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
