// POST /api/chat/branch — Run 39, THE FORK: flip the displayed
// conversation to a sibling branch at a fork point (‹ › on the fork
// switcher). The chat's activeLeafId moves to the chosen branch's
// deepest newest continuation and the resolved active path comes
// back — the SAME resolution the chat loader uses, so a reload
// keeps exactly the branch the user flipped to.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  advanceLeaf,
  deepestDescendant,
  ensureChatTree,
  resolveActivePath,
  serializeRow,
  type TreeRow,
} from "@/lib/hermes/tree";
import { ensureSeed } from "@/lib/hermes/seed";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  await ensureSeed();
  const body = (await req.json().catch(() => ({}))) as {
    chatId?: string;
    messageId?: string;
    dir?: number;
  };
  const chatId = body.chatId ?? "";
  const messageId = body.messageId ?? "";
  const dir = body.dir === 1 || body.dir === -1 ? body.dir : 0;
  if (!chatId || !messageId || dir === 0) {
    return NextResponse.json(
      { error: "chatId, messageId and dir (-1 | 1) are required" },
      { status: 400 }
    );
  }

  const chat = await db.chat.findUnique({ where: { id: chatId } });
  if (!chat) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }

  const target = await db.message.findUnique({ where: { id: messageId } });
  if (!target || target.chatId !== chatId) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }

  // The fork group: every sibling under the same parent, in branch
  // order (linear-era chats self-heal first so pre-FORK edits sit at
  // the right depth).
  await ensureChatTree(chatId);
  const siblings = await db.message.findMany({
    where: { chatId, parentMessageId: target.parentMessageId },
    orderBy: [{ branchIndex: "asc" }, { createdAt: "asc" }],
  });
  const pos = siblings.findIndex((s) => s.id === messageId);
  if (pos === -1) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  const neighbour = siblings[pos + dir];
  if (!neighbour) {
    return NextResponse.json(
      { error: "No branch in that direction" },
      { status: 400 }
    );
  }

  // The branch shows its latest state: follow the newest children down.
  const leafId = await deepestDescendant(neighbour.id);
  await advanceLeaf(chatId, leafId);
  await db.chat.update({
    where: { id: chatId },
    data: { updatedAt: new Date() },
  });

  const rows = (await db.message.findMany({
    where: { chatId },
    orderBy: { createdAt: "asc" },
  })) as unknown as TreeRow[];
  const resolved = resolveActivePath(rows, leafId);

  return NextResponse.json({
    messages: resolved
      ? resolved.path.map((r, i) => serializeRow(r, resolved.meta[i]))
      : [],
  });
}
