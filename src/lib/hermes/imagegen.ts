// Hermes — Run 22 Image Forge (server side).
// Calls the Z.ai image engine through z-ai-web-dev-sdk (server-only),
// writes the decoded file into generated-images/, and returns a
// self-contained ImageRef. Disk-backed on purpose: image bytes do not
// belong in SQLite; the DB stores only the JSON reference.

import fs from "fs";
import path from "path";
import ZAI from "z-ai-web-dev-sdk";
import { IMAGE_SIZES, isValidImageId, mimeOfImageId } from "./image-forge";
import type { ImageRef, ImageSize } from "./types";

export { isValidImageId, mimeOfImageId };

const IMAGE_DIR = path.join(process.cwd(), "generated-images");

export function imageFilePath(id: string): string {
  return path.join(IMAGE_DIR, id);
}

/** Remove a forged file (used when a turn was aborted mid-forge — no
 *  orphan images accumulate). Missing files are a no-op. */
export function discardImageFile(id: string): void {
  if (!isValidImageId(id)) return;
  try {
    fs.rmSync(imageFilePath(id), { force: true });
  } catch {
    // non-fatal
  }
}

/** Forge one image. The engine needs 30–90s — callers hold the
 *  request open (the client shows a live generating card meanwhile). */
export async function forgeImage(
  prompt: string,
  size: ImageSize
): Promise<ImageRef> {
  const cfg = IMAGE_SIZES[size] ?? IMAGE_SIZES.square;
  const zai = await ZAI.create();
  const t0 = Date.now();
  const response = await zai.images.generations.create({
    prompt,
    // The engine's own literal union — dims is authored to match it.
    size: cfg.dims as "1024x1024",
  });
  const first = response?.data?.[0];
  const b64 = typeof first?.base64 === "string" ? first.base64 : "";
  if (!b64) {
    throw new Error("The image engine returned no image. Try again in a moment.");
  }
  const buffer = Buffer.from(b64, "base64");
  // The SDK types expose only base64; the runtime also returns a
  // `format` field ("jpeg" observed) — read it defensively.
  const fmtRaw = (first as { format?: unknown } | undefined)?.format;
  const ext =
    typeof fmtRaw === "string" && /png/i.test(fmtRaw) ? "png" : "jpg";
  const id = `img-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}.${ext}`;
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  fs.writeFileSync(imageFilePath(id), buffer);
  return {
    id,
    mime: ext === "png" ? "image/png" : "image/jpeg",
    width: cfg.width,
    height: cfg.height,
    bytes: buffer.length,
    ms: Date.now() - t0,
    prompt,
  };
}
