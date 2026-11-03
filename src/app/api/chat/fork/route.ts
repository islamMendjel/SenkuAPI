// POST /api/chat/fork — Run 39, THE FORK: non-destructive message
// editing. The old behaviour (/api/chat/truncate) UPDATED the edited
// row in place and DELETE-Many'd every message after it — permanent
// destruction on every edit. The fork model: the edit becomes a NEW
// SIBLING under the same parent (branchIndex = sibling count) and the
// original turn — with ALL of its descendants — stays in the
// database, one ‹ › click away on the fork switcher.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  advanceLeaf,
  ensureChatTree,
  nextChildSlot,
  serializeRow,
} from "@/lib/hermes/tree";
import { ensureSeed } from "@/lib/hermes/seed";

export const dynamic = "force-dynamic";

const MAX_CONTENT = 100_000;

export async function POST(req: NextRequest) {
  await ensureSeed();
  const body = (await req.json().catch(() => ({}))) as {
    messageId?: string;
    content?: string;
  };
  const messageId = body.messageId ?? "";
  const content = (body.content ?? "").trim();
  if (!messageId || !content) {
    return NextResponse.json(
      { error: "messageId and content are required" },
      { status: 400 }
    );
  }
  if (content.length > MAX_CONTENT) {
    return NextResponse.json(
      { error: "content exceeds the size limit" },
      { status: 413 }
    );
  }

  const original = await db.message.findUnique({ where: { id: messageId } });
  if (!original) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  if (original.role !== "user") {
    return NextResponse.json(
      { error: "Only your own messages can be edited" },
      { status: 400 }
    );
  }
  const chat = await db.chat.findUnique({ where: { id: original.chatId } });
  if (!chat || chat.isTemporary) {
    return NextResponse.json(
      { error: "Branching lives in saved chats" },
      { status: 400 }
    );
  }

  // Linear-era self-heal, then the edit joins its parent's sibling
  // group as the newest branch — at the RIGHT depth even for
  // pre-FORK conversations.
  await ensureChatTree(original.chatId);
  const slot = await nextChildSlot(original.chatId, original.parentMessageId);
  const fork = await db.message.create({
    data: {
      chatId: original.chatId,
      role: "user",
      content,
      // An edited turn keeps the files the original turn carried.
      attachments: original.attachments,
      parentMessageId: slot.parentMessageId,
      branchIndex: slot.branchIndex,
    },
  });
  // The fork row (no replies yet) becomes the displayed leaf; the
  // streamed answer will chain to it and advance the leaf again.
  await advanceLeaf(original.chatId, fork.id);
  await db.chat.update({
    where: { id: original.chatId },
    data: { updatedAt: new Date() },
  });

  return NextResponse.json({
    message: serializeRow(fork, {
      branchIndex: slot.branchIndex,
      siblingCount: slot.branchIndex + 1,
      siblingPosition: slot.branchIndex,
    }),
  });
}
