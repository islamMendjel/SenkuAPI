// GET /api/bootstrap — one-shot app state (user, providers, limiter,
// chats, image gallery count, memory, rituals).
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { USER } from "@/lib/hermes/constants";
import { ensureSeed } from "@/lib/hermes/seed";
import { usageSnapshot } from "@/lib/hermes/serialize";
import { listGalleryImages } from "@/lib/hermes/gallery";
import { getMemories } from "@/lib/hermes/memory";
import { listRituals } from "@/lib/hermes/ritual";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureSeed();
    const [snapshot, chats, galleryImages, memories, rituals] = await Promise.all([
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
      listRituals(),
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
      // Run 34 — scheduled prompts (Rituals): the sidebar row badge
      // and the management dialog both read this list; the dialog
      // refetches on open + polls while open for live countdowns.
      rituals,
    });
  } catch (e) {
    console.error("bootstrap failed", e);
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
