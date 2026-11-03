// GET /api/images — the image Gallery (Run 23).
//   /api/images        → { images: GalleryItem[] } (newest first)
//   /api/images?count=1 → { count } — cheap refresh for the sidebar
//                        badge after a chat delete / a forge.
import { NextRequest, NextResponse } from "next/server";
import { listGalleryImages } from "@/lib/hermes/gallery";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const images = await listGalleryImages();
    if (new URL(req.url).searchParams.get("count") === "1") {
      return NextResponse.json({ count: images.length });
    }
    return NextResponse.json({ images });
  } catch (e) {
    console.error("gallery list failed", e);
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
