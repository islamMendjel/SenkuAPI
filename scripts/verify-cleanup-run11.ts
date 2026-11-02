// Check the fate of each verification turn + cleanup test chats.
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const chats = await db.chat.findMany({
  where: { title: { contains: "run11" } },
  orderBy: { createdAt: "asc" },
  include: { messages: true },
});
for (const c of chats) {
  console.log(
    c.title.slice(0, 50).padEnd(50),
    "| msgs:", c.messages.length,
    "| assistant:", JSON.stringify(c.messages.find((m) => m.role === "assistant")?.content ?? null)
  );
}
// Usage events for these chats (billing integrity post-heal)
const evs = await db.usageEvent.count({
  where: { chatId: { in: chats.map((c) => c.id) } },
});
console.log("usage events across test chats:", evs);
// Cleanup: remove test chats + their messages + usage events
for (const c of chats) {
  await db.message.deleteMany({ where: { chatId: c.id } });
  await db.usageEvent.deleteMany({ where: { chatId: c.id } });
  await db.chat.delete({ where: { id: c.id } });
}
console.log("cleaned test chats:", chats.length);
// Purge test cache rows
const del = await db.responseCache.deleteMany({
  where: {
    OR: [
      { content: { contains: "self-heal-proof" } },
      { content: { contains: "database-write-verified" } },
      { content: { contains: "writable-test" } },
    ],
  },
});
console.log("purged cache rows:", del.count);
await db.$disconnect();
