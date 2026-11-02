// Check how recent assistant messages were served (provider vs cloud vs cache)
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const msgs = await db.message.findMany({
  where: { role: "assistant" },
  orderBy: { createdAt: "desc" },
  take: 30,
  select: {
    id: true, createdAt: true, model: true, provider: true,
    keyLabel: true, cached: true, tokens: true, effort: true,
    content: true,
  },
});
for (const m of msgs) {
  console.log(
    new Date(m.createdAt).toISOString().slice(5, 16),
    "| keyLabel:", String(m.keyLabel).padEnd(12),
    "| cached:", m.cached ? "Y" : "N",
    "| tokens:", String(m.tokens).padStart(6),
    "| effort:", String(m.effort ?? "medium").padEnd(7),
    "| model:", String(m.model).padEnd(22),
    "| chars:", m.content.length
  );
}
await db.$disconnect();
