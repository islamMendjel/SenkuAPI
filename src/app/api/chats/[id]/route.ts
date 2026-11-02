// GET    /api/chats/[id] — chat with messages
// PATCH  /api/chats/[id] — rename
// DELETE /api/chats/[id] — delete
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const chat = await db.chat.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!chat) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }
  return NextResponse.json({
    ...chat,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
    messages: chat.messages.map((m) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
      sources: m.sources ? JSON.parse(m.sources) : null,
      attachments: m.attachments ? JSON.parse(m.attachments) : null,
      // Regenerate variant history (JSON column → array).
      variants: m.variants ? JSON.parse(m.variants) : null,
    })),
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const chat = await db.chat.update({
    where: { id },
    data: {
      title:
        typeof body.title === "string" && body.title.trim()
          ? body.title.trim().slice(0, 80)
          : undefined,
    },
  });
  return NextResponse.json({
    ...chat,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await db.chat.delete({ where: { id } });
  } catch (e) {
    const err = e as { code?: string };
    // P2025 = record not found — deleting an already-deleted chat
    // is idempotent success from the client's perspective.
    if (err.code !== "P2025") throw e;
  }
  return NextResponse.json({ ok: true });
}
