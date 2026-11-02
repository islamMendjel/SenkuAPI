// Probe cloud streaming WITH thinking + longer output to see
// progressive timing and whether reasoning arrives separately.
import ZAI from "z-ai-web-dev-sdk";

const zai = await ZAI.create();
const stream = await zai.chat.completions.create({
  messages: [
    { role: "user", content: "Write a 120-word paragraph about tides, then stop." },
  ],
  thinking: { type: "enabled" },
  stream: true,
});

const reader = stream.getReader();
const decoder = new TextDecoder();
let buffer = "";
let n = 0;
let contentChars = 0;
let reasoningChars = 0;
let firstContentAt = null;
let firstChunkAt = null;
const t0 = Date.now();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      if (firstChunkAt === null) firstChunkAt = Date.now() - t0;
      const d = chunk.choices?.[0]?.delta;
      if (d?.content) {
        contentChars += d.content.length;
        if (firstContentAt === null) firstContentAt = Date.now() - t0;
      }
      if (d?.reasoning_content) reasoningChars += d.reasoning_content.length;
      n++;
      if (n <= 3)
        console.log(
          `[${Date.now() - t0}ms] chunk keys:`, Object.keys(d ?? {}).join(","),
          "| usage:", chunk.usage ? JSON.stringify(chunk.usage) : "none"
        );
    } catch {}
  }
}
console.log("\nchunks:", n, "| content chars:", contentChars, "| reasoning chars:", reasoningChars);
console.log("first chunk at:", firstChunkAt, "ms | first content at:", firstContentAt, "ms | wall:", Date.now() - t0, "ms");
