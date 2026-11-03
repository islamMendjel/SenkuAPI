// GET  /api/memory — list memory entries (oldest first)
// POST /api/memory — add one { content }
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  MEMORY_MAX_CHARS,
  MEMORY_MAX_ENTRIES,
  sanitizeMemory,
} from "@/lib/hermes/constants";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.memory.findMany({
    orderBy: { createdAt: "asc" },
    take: MEMORY_MAX_ENTRIES,
    select: { id: true, content: true, createdAt: true },
  });
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { content?: unknown };
  const content = sanitizeMemory(body.content);
  if (!content) {
    return NextResponse.json(
      { error: `Memory must be 1–${MEMORY_MAX_CHARS} characters.` },
      { status: 400 }
    );
  }
  const count = await db.memory.count();
  if (count >= MEMORY_MAX_ENTRIES) {
    return NextResponse.json(
      { error: `Memory is full (${MEMORY_MAX_ENTRIES} entries). Remove one first.` },
      { status: 409 }
    );
  }
  const row = await db.memory.create({ data: { content } });
  return NextResponse.json(
    { id: row.id, content: row.content, createdAt: row.createdAt },
    { status: 201 }
  );
}
