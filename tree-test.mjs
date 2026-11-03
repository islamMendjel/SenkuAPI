// Server-side reproduction: 3 turns, then fork turn 1, inspect.
const BASE = "http://localhost:3000";

async function send(content, chatId) {
  const res = await fetch(`${BASE}/api/chat/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: chatId ?? null, history: [], content, model: "free/glm-5.3", search: false }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", meta = null, done = null;
  for (;;) {
    const { done: d, value } = await reader.read();
    if (d) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      if (chunk.startsWith("data: ")) {
        const ev = JSON.parse(chunk.slice(6));
        if (ev.type === "meta") meta = ev;
        if (ev.type === "done") done = ev;
      }
    }
  }
  return { meta, done };
}

const t1 = await send("Say A.");
const chatId = t1.meta.chatId;
console.log("chat:", chatId, "turn1 user:", t1.meta.userMessageId);
await send("Say B.", chatId);
const t3 = await send("Say C.", chatId);
console.log("turn3 user:", t3.meta.userMessageId, "assistant:", t3.done?.assistantMessageId ?? "(check meta/done)");

// inspect
const chat = await (await fetch(`${BASE}/api/chats/${chatId}`)).json();
console.log("path len:", chat.messages.length);
for (const m of chat.messages) console.log(`  ${m.id} [b${m.branchIndex ?? "-"}] ${m.role} parent=${m.parentMessageId ?? "NULL"} sc=${m.siblingCount ?? "-"} :: ${m.content.slice(0, 30)}`);

// FORK turn 1's user row
const turn1UserId = chat.messages[0].id;
const fr = await fetch(`${BASE}/api/chat/fork`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messageId: turn1UserId, content: "Say A differently." }),
});
const fd = await fr.json();
console.log("FORK status:", fr.status, "fork row:", fd.message?.id, "parent:", fd.message?.parentMessageId, "b:", fd.message?.branchIndex, "sc:", fd.message?.siblingCount);
