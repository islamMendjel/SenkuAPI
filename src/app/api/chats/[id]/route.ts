// GET    /api/chats/[id] — chat with the ACTIVE branch path
// PATCH  /api/chats/[id] — rename
// DELETE /api/chats/[id] — delete
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveActivePath, serializeRow, type TreeRow } from "@/lib/hermes/tree";

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
  // Run 39 — THE FORK: the chat is a tree; the timeline shows the
  // ACTIVE PATH (leaf → root walk). ‹ › metadata rides on every
  // fork node so the switcher renders without extra round-trips.
  const { messages, ...chatFields } = chat;
  const rows = messages as unknown as TreeRow[];
  const resolved = resolveActivePath(rows, chat.activeLeafId);
  return NextResponse.json({
    ...chatFields,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
    messages: resolved
      ? resolved.path.map((r, i) => serializeRow(r, resolved.meta[i]))
      : [],
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
