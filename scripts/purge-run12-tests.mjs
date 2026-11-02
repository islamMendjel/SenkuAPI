// Run 12 cleanup — purge ONLY this run's test cache rows, matched by
// the nonce words planted in each test answer (or its opening words).
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const patterns = [
  "KAIROX7", // turn 1 — 500-word lighthouse story
  "LUMEN42", // turn 2 — cartographer island story (skip test)
  "ECHO88", // turns 3+4 — reduced-motion radio-host / clockmaker stories
  "VEGA77", // turn 8 — Thursday-country mapmaker story (click-text skip)
  "ORION55", // turn 7 — librarian dream story
  "NOVA61", // turn 6 — gardener door story
  "ATLAS33", // turn 9 — duel sky-blue lanes
  "COMET21", // turn 10 — mid-typing screenshot story
  "clamp(value: number", // turn 5 — the clamp utility code answer
];
let total = 0;
for (const p of patterns) {
  const r = await db.responseCache.deleteMany({
    where: { content: { contains: p } },
  });
  total += r.count;
}
console.log("purged test cache rows:", total);
// Verify nothing else lingered — all test turns were temporary=true.
const tmp = await db.chat.count({ where: { isTemporary: true } });
console.log("temporary chats in DB:", tmp);
await db.$disconnect();
