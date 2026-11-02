// Experiments: how does SqliteError 1032 ("attempt to write a readonly
// database") arise on a live Prisma connection, and what heals it?
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

const DB = "/home/z/my-project/db/custom.db";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryWrite(client, label) {
  try {
    const c = await client.chat.create({
      data: { title: "exp-" + Date.now(), model: "t", provider: "t", isTemporary: true },
    });
    await client.chat.delete({ where: { id: c.id } });
    console.log(`${label}: WRITE OK`);
  } catch (e) {
    console.log(`${label}: WRITE FAILED — …${String((e as Error)?.message ?? "").slice(-260).replace(/\n/g, " | ")}`);
  }
}

// E1: chmod 444 while a client holds an open pool
const c1 = new PrismaClient();
await tryWrite(c1, "E1 baseline (before chmod)");
fs.chmodSync(DB, 0o444);
await tryWrite(c1, "E1 after chmod 444 (same client)");
fs.chmodSync(DB, 0o664);
await tryWrite(c1, "E1 after chmod back 664 (same client)");
await c1.$disconnect();

// E2: fresh client while file is 444 (simulates reopen on a bad file)
fs.chmodSync(DB, 0o444);
const c2 = new PrismaClient();
await tryWrite(c2, "E2 fresh client on 444 file");
fs.chmodSync(DB, 0o664);
await tryWrite(c2, "E2 same client after 664 restore");
await c2.$disconnect();

// E3: replace the file under a live client (git stash/pop simulation)
const c3 = new PrismaClient();
await tryWrite(c3, "E3 baseline (before replace)");
fs.copyFileSync(DB, "/tmp/db-backup.db");
fs.renameSync(DB, "/tmp/db-moved-away.db");
fs.copyFileSync("/tmp/db-backup.db", DB); // new inode, same content
await tryWrite(c3, "E3 after file replaced (new inode) — writes go to the UNLINKED old inode");
const cnt = await c3.chat.count();
console.log("E3 count via old handle:", cnt);
await c3.$disconnect();
const c4 = new PrismaClient();
console.log("E3 count via fresh handle:", await c4.chat.count());
await c4.$disconnect();
fs.rmSync("/tmp/db-moved-away.db", { force: true });
fs.rmSync("/tmp/db-backup.db", { force: true });
console.log("done");
