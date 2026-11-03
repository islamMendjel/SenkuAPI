// POST /api/chat/leaf — Run 39, THE FORK: move the displayed branch's
// leaf pointer (chat.activeLeafId) to a specific message. Used by the
// regenerate flow: the old answer row STAYS in the tree (it becomes a
// sibling branch the fork switcher can still reach); the leaf rewinds
// to the turn's user row so the fresh answer chains as its child.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { advanceLeaf } from "@/lib/hermes/tree";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    chatId?: string;
    messageId?: string;
  };
  const chatId = body.chatId ?? "";
  const messageId = body.messageId ?? "";
  if (!chatId || !messageId) {
    return NextResponse.json(
      { error: "chatId and messageId are required" },
      { status: 400 }
    );
  }
  const row = await db.message.findFirst({
    where: { id: messageId, chatId },
    select: { id: true },
  });
  if (!row) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  await advanceLeaf(chatId, messageId);
  return NextResponse.json({ ok: true });
}
