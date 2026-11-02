// VERIFY: cache-hit turns now type out word-by-word instead of a
// single mega-delta. Run the SAME prompt twice; the second turn is
// cached. Purge the test cache rows afterwards.
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const NONCE = "verify-run10-cache-" + Date.now();
const body = {
  content: `Reply with exactly: The quick brown fox jumps over the lazy dog near the river bank at dawn. ${NONCE}`,
  model: "free/glm-5.3",
  search: false,
  temporary: true,
  effort: "medium",
  history: [],
};

async function run(label) {
  const t0 = Date.now();
  const res = await fetch("http://localhost:3000/api/chat/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let deltaCount = 0;
  let firstAt = null, lastAt = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      let ev;
      try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      const t = Date.now() - t0;
      if (ev.type === "delta") {
        deltaCount++;
        if (firstAt === null) firstAt = t;
        lastAt = t;
        if (label === "CACHED" && deltaCount <= 4)
          console.log(`[${t}ms] delta #${deltaCount}: ${JSON.stringify(ev.text.slice(0, 24))}`);
      } else if (ev.type === "done") {
        console.log(`[${t}ms] done cached=${ev.cached} servedBy=${ev.servedBy}`);
      }
    }
  }
  console.log(`${label}: deltas=${deltaCount} typingWindow=${lastAt - firstAt}ms wall=${Date.now() - t0}ms\n`);
  return { deltaCount, window: lastAt - firstAt };
}

const fresh = await run("FRESH");
const cached = await run("CACHED");

console.log("=== CACHE PATH SUMMARY ===");
console.log(cached.deltaCount > 3 && cached.window > 50
  ? "✅ PASS — cached answer types out word-by-word"
  : "❌ FAIL — cached answer still dumped in one shot");

// Purge test cache rows (nonce-tagged) so the user's cache stays clean.
const del = await db.responseCache.deleteMany({
  where: { cacheKey: { contains: NONCE.slice(0, 24) } },
});
// Also purge by content match (the cache key is a hash — match on content)
const del2 = await db.responseCache.deleteMany({
  where: { content: { contains: "quick brown fox jumps over the lazy dog near the river bank at dawn" } },
});
console.log("purged cache rows:", del.count + del2.count);
await db.$disconnect();
