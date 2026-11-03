// PATCH   /api/projects/[id] — rename and/or edit instructions
// DELETE  /api/projects/[id] — delete the project, KEEP its chats
// Run 37 — deleting a project is SetNull by schema: the chats
// simply fall back to "Recent". Editing instructions changes the
// injected prompt block → the response-cache key moves naturally.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ensureSeed } from "@/lib/hermes/seed";
import { sanitizeProjectInput } from "@/lib/hermes/projects";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureSeed();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const existing = await db.project.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  // Partial updates: name and/or instructions. A missing field
  // keeps its current value (the dialog always sends both, but the
  // contract stays PATCH-shaped).
  const candidate = {
    name:
      typeof body.name === "string"
        ? body.name
        : existing.name,
    instructions:
      typeof body.instructions === "string"
        ? body.instructions
        : existing.instructions,
  };
  const clean = sanitizeProjectInput(candidate);
  if (!clean.ok) {
    return NextResponse.json({ error: clean.error }, { status: 400 });
  }

  const project = await db.project.update({
    where: { id },
    data: { name: clean.name, instructions: clean.instructions },
    select: { id: true, name: true, instructions: true },
  });
  return NextResponse.json({ project });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureSeed();
  const { id } = await params;
  const existing = await db.project.findUnique({
    where: { id },
    select: { id: true, name: true, _count: { select: { chats: true } } },
  });
  if (!existing) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  // SetNull: chats survive, projectId → null (back to Recent).
  await db.project.delete({ where: { id } });
  return NextResponse.json({
    ok: true,
    releasedChats: existing._count.chats,
  });
}
