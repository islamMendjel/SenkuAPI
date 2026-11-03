// POST /api/chats/[id]/move — move a chat into a project (or back
// to "Recent" with projectId: null). Run 37 — THE PROJECTS.
// The chat's OWN row is the server truth the gateway reads every
// turn, so a move immediately re-scopes the system prompt.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ensureSeed } from "@/lib/hermes/seed";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureSeed();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const chat = await db.chat.findUnique({ where: { id } });
  if (!chat) {
    return NextResponse.json({ error: "Chat not found." }, { status: 404 });
  }

  const target =
    typeof body.projectId === "string" && body.projectId
      ? body.projectId
      : null;

  if (target) {
    const project = await db.project.findUnique({
      where: { id: target },
      select: { id: true, name: true },
    });
    if (!project) {
      return NextResponse.json(
        { error: "Project not found." },
        { status: 404 }
      );
    }
    await db.chat.update({
      where: { id },
      data: { projectId: target },
    });
    return NextResponse.json({ ok: true, projectId: target, name: project.name });
  }

  await db.chat.update({ where: { id }, data: { projectId: null } });
  return NextResponse.json({ ok: true, projectId: null, name: null });
}
