// POST /api/chat/truncate — message timeline editing:
// update a message's content and delete every message after it.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const messageId = body.messageId as string | undefined;
  if (!messageId) {
    return NextResponse.json({ error: "messageId is required" }, { status: 400 });
  }

  const message = await db.message.findUnique({ where: { id: messageId } });
  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }

  if (typeof body.content === "string" && body.content.trim()) {
    await db.message.update({
      where: { id: messageId },
      data: { content: body.content.trim() },
    });
  }

  // Delete all messages that came after the edited one.
  await db.message.deleteMany({
    where: { chatId: message.chatId, createdAt: { gt: message.createdAt } },
  });

  const messages = await db.message.findMany({
    where: { chatId: message.chatId },
    orderBy: { createdAt: "asc" },
  });
  await db.chat.update({
    where: { id: message.chatId },
    data: { updatedAt: new Date() },
  });

  return NextResponse.json({
    messages: messages.map((m) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
      sources: m.sources ? JSON.parse(m.sources) : null,
      attachments: m.attachments ? JSON.parse(m.attachments) : null,
    })),
  });
}
