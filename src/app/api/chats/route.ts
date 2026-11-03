// GET  /api/chats        — list persisted (non-temporary) chats
// POST /api/chats        — create a chat
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ensureSeed } from "@/lib/hermes/seed";
import { getActiveProvider } from "@/lib/hermes/router";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeed();
  const chats = await db.chat.findMany({
    where: { isTemporary: false },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  return NextResponse.json(
    chats.map((c) => ({
      ...c,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }))
  );
}

export async function POST(req: NextRequest) {
  await ensureSeed();
  const body = await req.json().catch(() => ({}));
  const provider = await getActiveProvider();
  const models: string[] = JSON.parse(provider.models || "[]");
  const chat = await db.chat.create({
    data: {
      title: typeof body.title === "string" && body.title.trim()
        ? body.title.trim().slice(0, 80)
        : "New chat",
      model: typeof body.model === "string" ? body.model : models[0] ?? "free/glm-5.3",
      provider: provider.name,
      isTemporary: body.temporary === true,
    },
  });
  return NextResponse.json({
    ...chat,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  });
}
