// GET /api/bootstrap — one-shot app state (user, providers, limiter, chats)
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { USER } from "@/lib/senku/constants";
import { ensureSeed } from "@/lib/senku/seed";
import { usageSnapshot } from "@/lib/senku/serialize";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureSeed();
    const [snapshot, chats] = await Promise.all([
      usageSnapshot(),
      db.chat.findMany({
        where: { isTemporary: false },
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: {
          id: true,
          title: true,
          model: true,
          provider: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);
    return NextResponse.json({
      user: USER,
      ...snapshot,
      chats: chats.map((c) => ({
        ...c,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
    });
  } catch (e) {
    console.error("bootstrap failed", e);
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
