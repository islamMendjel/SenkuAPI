// Purge ONLY this run's test cache rows (matched by test-answer content).
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const patterns = [
  "Mountains are elevated", // cloud-path test answer
  "The sea breath", // obs timing test answer
  "quick brown fox jumps over the lazy dog near the river bank at dawn", // cache test (already purged, double-check)
];
let total = 0;
for (const p of patterns) {
  const r = await db.responseCache.deleteMany({ where: { content: { contains: p } } });
  total += r.count;
}
console.log("purged test cache rows:", total);
// Also verify no test chats lingered (all tests were temporary=true)
const tmp = await db.chat.count({ where: { isTemporary: true } });
console.log("temporary chats in DB:", tmp);
await db.$disconnect();
