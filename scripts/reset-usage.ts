// One-off: reset token usage to exactly 0.
// Deletes every UsageEvent and zeroes the keys' monthly accumulators
// so the Ultimate plan usage counter starts fresh and only grows
// from real traffic (metered ×4 on every request).

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const deleted = await db.usageEvent.deleteMany({});
  await db.apiKey.updateMany({ data: { tokensUsedThisMonth: 0 } });
  console.log(
    `Reset complete — deleted ${deleted.count} usage events. Usage now starts at 0.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
