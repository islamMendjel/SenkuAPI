// PATCH  /api/memory/[id] — edit one entry { content }
// DELETE /api/memory/[id] — remove one entry
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { MEMORY_MAX_CHARS, sanitizeMemory } from "@/lib/senku/constants";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { content?: unknown };
  const content = sanitizeMemory(body.content);
  if (!content) {
    return NextResponse.json(
      { error: `Memory must be 1–${MEMORY_MAX_CHARS} characters.` },
      { status: 400 }
    );
  }
  const row = await db
    .memory.update({
      where: { id },
      data: { content },
      select: { id: true },
    })
    .catch(() => null);
  if (!row) return NextResponse.json({ error: "Memory not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const row = await db.memory
    .delete({ where: { id }, select: { id: true } })
    .catch(() => null);
  if (!row) return NextResponse.json({ error: "Memory not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
