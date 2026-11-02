// Probe the Z.ai cloud runtime's REAL streaming format.
import ZAI from "z-ai-web-dev-sdk";

const zai = await ZAI.create();
const stream = await zai.chat.completions.create({
  messages: [
    { role: "user", content: "Count from one to five in words, nothing else." },
  ],
  thinking: { type: "disabled" },
  stream: true,
});

console.log("returned:", typeof stream, stream?.constructor?.name);
const reader = stream.getReader();
const decoder = new TextDecoder();
let buffer = "";
let n = 0;
const t0 = Date.now();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    n++;
    if (n <= 8) console.log(`[${Date.now() - t0}ms] line:`, trimmed.slice(0, 200));
  }
}
console.log("total lines:", n, "| wall:", Date.now() - t0, "ms");
