// Run 14 — drive the REAL store.refreshUsage with a stubbed fetch
// whose dailyResetsAt is 3s in the future. The rollover timer must
// re-pull on its own (~4s) without any caller.
const calls = [];
globalThis.fetch = async (url) => {
  calls.push({ t: Date.now(), url: String(url) });
  const base = JSON.parse(await Bun.file("/tmp/usage-real.json").text());
  base.limiter.dailyResetsAt = new Date(Date.now() + 3000).toISOString();
  return new Response(JSON.stringify(base), {
    headers: { "Content-Type": "application/json" },
  });
};

// Import the real client store (zustand runs fine outside the browser)
const { useSenku } = await import("../src/lib/store.ts");
console.log("t=0.0s  initial refreshUsage() …");
const t0 = Date.now();
await useSenku.getState().refreshUsage();
console.log(`  limiter.dailyResetsAt armed → ${useSenku.getState().limiter?.dailyResetsAt}`);

await new Promise((r) => setTimeout(r, 36000));
console.log(`t=36.0s  fetch calls: ${calls.length}`);
for (const c of calls) {
  console.log(`  +${((c.t - t0) / 1000).toFixed(1)}s  ${c.url}`);
}
const ok =
  calls.length === 2 &&
  calls[1].t - t0 >= 28000 &&
  calls[1].t - t0 <= 35000;
console.log(ok
  ? "✓ rollover timer re-pulled /api/usage on its own, right after the reset instant"
  : "✗ rollover timer did not re-pull as expected");
process.exit(ok ? 0 : 1);
