// OBSERVE: stream a real turn and timestamp every SSE event
// to see whether deltas arrive progressively or in one burst.
const NONCE = "obs-run10-" + Date.now();
const body = {
  content: `Write exactly four short numbered lines about the sea. ${NONCE}`,
  model: "free/glm-5.3",
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
console.log("HTTP", res.status, "| headers:", res.headers.get("content-type"));

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
      if (deltaCount <= 5 || deltaCount % 20 === 0) {
        console.log(`[${t}ms] delta #${deltaCount} (${ev.text.length}ch): ${JSON.stringify(ev.text.slice(0, 40))}`);
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
console.log("\n=== SUMMARY ===");
console.log("total deltas:", deltaCount);
console.log("total chars:", totalChars);
console.log("first delta at:", firstDeltaAt, "ms");
console.log("last delta at:", lastDeltaAt, "ms");
console.log("stream duration:", lastDeltaAt !== null ? lastDeltaAt - firstDeltaAt : 0, "ms");
console.log("total wall time:", Date.now() - t0, "ms");
