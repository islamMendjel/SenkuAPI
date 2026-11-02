// VERIFY: the cloud-failover path now streams word-by-word.
// free/claude-4.6-opus reliably 404s on the provider -> every key
// fails -> Z.ai cloud. This is the exact path the user complained
// about (long silent wait, then a single-shot dump).
const NONCE = "verify-run10-cloud-" + Date.now();
const body = {
  content: `Write exactly five short numbered lines about mountains. ${NONCE}`,
  model: "free/claude-4.6-opus",
  search: false,
  temporary: true,
  effort: "medium",
  history: [],
};

const t0 = Date.now();
const res = await fetch("http://localhost:3000/api/chat/send", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
console.log("HTTP", res.status);

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let deltaCount = 0;
let firstDeltaAt = null;
let lastDeltaAt = null;
let totalChars = 0;

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
    try {
      ev = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    const t = Date.now() - t0;
    if (ev.type === "delta") {
      deltaCount++;
      totalChars += String(ev.text ?? "").length;
      if (firstDeltaAt === null) firstDeltaAt = t;
      lastDeltaAt = t;
      if (deltaCount <= 6 || deltaCount % 15 === 0) {
        console.log(`[${t}ms] delta #${deltaCount} (${ev.text.length}ch): ${JSON.stringify(ev.text.slice(0, 30))}`);
      }
    } else {
      const summary =
        ev.type === "done"
          ? `servedBy=${ev.servedBy} key=${ev.keyLabel} model=${ev.model} tokens=${ev.tokens} cached=${ev.cached}`
          : "";
      console.log(`[${t}ms] ${ev.type} ${summary}`);
    }
  }
}
console.log("\n=== CLOUD PATH SUMMARY ===");
console.log("deltas:", deltaCount, "| chars:", totalChars);
console.log("first delta at:", firstDeltaAt, "ms");
console.log("typing window:", lastDeltaAt - firstDeltaAt, "ms");
console.log("wall:", Date.now() - t0, "ms");
console.log(deltaCount > 5 && lastDeltaAt - firstDeltaAt > 300
  ? "✅ PASS — progressive word-by-word typing on the cloud path"
  : "❌ FAIL — still a single-shot dump");
