// GET /api/image/file/[id] — serve one forged image (Run 22).
// Ids are validated against the strict forge pattern (no traversal);
// file content never changes for a given id, so responses are
// immutable-cached. `?download=1` switches to an attachment.
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { imageFilePath, isValidImageId, mimeOfImageId } from "@/lib/senku/imagegen";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isValidImageId(id)) {
    return new NextResponse("Not found", { status: 404 });
  }
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(imageFilePath(id));
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
  const download = new URL(req.url).searchParams.get("download") === "1";
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": mimeOfImageId(id),
      "Content-Length": String(buffer.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      ...(download
        ? { "Content-Disposition": `attachment; filename="senku-${id}"` }
        : {}),
    },
  });
}
