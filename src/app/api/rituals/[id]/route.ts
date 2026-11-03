// PATCH  /api/rituals/[id] — pause/resume, rename, re-prompt
// DELETE /api/rituals/[id] — remove the ritual AND its dedicated
//                            chat (the cascade takes the ritual with
//                            the chat, exactly like deleting the chat
//                            from the sidebar takes its ritual).
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { RITUAL_MAX_PROMPT_CHARS, RITUAL_MAX_TITLE_CHARS } from "@/lib/hermes/constants";
import { computeNextRun, ritualView } from "@/lib/hermes/ritual";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const existing = await db.ritual.findUnique({
    where: { id },
    include: { chat: { select: { title: true } } },
  });
  if (!existing) {
    return NextResponse.json({ error: "Ritual not found" }, { status: 404 });
  }

  // Field-by-field — the client payload is never trusted whole.
  const data: {
    isActive?: boolean;
    title?: string;
    prompt?: string;
    nextRunAt?: Date;
  } = {};

  if (typeof body.isActive === "boolean" && body.isActive !== existing.isActive) {
    data.isActive = body.isActive;
    // Resuming recomputes the next occurrence from NOW — a ritual
    // paused for a week must not fire five stale catch-ups the
    // second it comes back. Pausing leaves nextRunAt alone (the
    // sweep skips inactive rituals).
    if (body.isActive) {
      data.nextRunAt = computeNextRun(
        existing.kind,
        existing.hour,
        existing.minute,
        existing.weekday,
        existing.intervalMin
      );
    }
  }

  if (typeof body.title === "string" && body.title.trim() && body.title !== existing.title) {
    const title = body.title.trim().slice(0, RITUAL_MAX_TITLE_CHARS);
    data.title = title;
    // The dedicated chat follows its ritual's name — one identity.
    await db.chat
      .update({ where: { id: existing.chatId }, data: { title } })
      .catch(() => {});
  }

  if (
    typeof body.prompt === "string" &&
    body.prompt.trim() &&
    body.prompt.trim() !== existing.prompt
  ) {
    data.prompt = body.prompt.trim().slice(0, RITUAL_MAX_PROMPT_CHARS);
  }

  const updated = await db.ritual.update({
    where: { id },
    data,
    include: { chat: { select: { title: true } } },
  });
  return NextResponse.json({ ritual: ritualView(updated, updated.chat.title) });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const ritual = await db.ritual.findUnique({
      where: { id },
      select: { chatId: true },
    });
    if (ritual) {
      // Deleting the chat cascades the ritual away with it — one
      // source of truth, zero orphans either direction.
      await db.chat.delete({ where: { id: ritual.chatId } });
    }
  } catch (e) {
    const err = e as { code?: string };
    if (err.code !== "P2025") {
      return NextResponse.json(
        { error: "Could not delete this ritual" },
        { status: 500 }
      );
    }
  }
  return NextResponse.json({ ok: true });
}
