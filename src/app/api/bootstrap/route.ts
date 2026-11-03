// GET /api/bootstrap — one-shot app state (user, providers, limiter,
// chats, image gallery count, memory).
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { USER } from "@/lib/senku/constants";
import { ensureSeed } from "@/lib/senku/seed";
import { usageSnapshot } from "@/lib/senku/serialize";
import { listGalleryImages } from "@/lib/senku/gallery";
import { getMemories } from "@/lib/senku/memory";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureSeed();
    const [snapshot, chats, galleryImages, memories] = await Promise.all([
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
      listGalleryImages(),
      getMemories(),
    ]);
    return NextResponse.json({
      user: USER,
      ...snapshot,
      chats: chats.map((c) => ({
        ...c,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
      // Run 23 — the sidebar's Images row badge: how many forged
      // images exist across all saved chats (disk-verified).
      imageCount: galleryImages.length,
      // Run 28 — the user's persistent memory (injected into every
      // system prompt by the gateway; surfaced in the profile menu
      // and the welcome screen as "remembers N things").
      memories,
    });
  } catch (e) {
    console.error("bootstrap failed", e);
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
