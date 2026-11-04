// Senku — Cloud-Only Image Forge Adapter (zero local compute).
// Fetches high-quality cloud generations, writes decoded files into
// generated-images/, and returns a self-contained ImageRef.
// Disk-backed on purpose: image bytes do not belong in SQLite; the DB
// stores only the JSON reference.

import fs from "fs";
import path from "path";
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

/** Forge one image via cloud endpoint. */
export async function forgeImage(
  prompt: string,
  size: ImageSize
): Promise<ImageRef> {
  const cfg = IMAGE_SIZES[size] ?? IMAGE_SIZES.square;
  const t0 = Date.now();
  const seed = Math.floor(Math.random() * 1_000_000);
  const cleanPrompt = prompt.trim().slice(0, 1000);

  // Cloud generative endpoint (Pollinations cloud pipeline with turbo model)
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?model=turbo&width=${cfg.width}&height=${cfg.height}&seed=${seed}&nologo=true`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "image/jpeg, image/png, image/*",
        "User-Agent": "Senku-Cloud/1.0",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Cloud image endpoint returned HTTP ${res.status}`);
    }

    const arrayBuf = await res.arrayBuffer();
    if (!arrayBuf || arrayBuf.byteLength === 0) {
      throw new Error("Cloud image provider returned an empty image.");
    }

    const buffer = Buffer.from(arrayBuf);
    const contentType = res.headers.get("content-type") || "image/jpeg";
    const ext = contentType.includes("png") ? "png" : "jpg";
    const mime = ext === "png" ? "image/png" : "image/jpeg";

    const id = `img-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}.${ext}`;

    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    fs.writeFileSync(imageFilePath(id), buffer);

    return {
      id,
      mime,
      width: cfg.width,
      height: cfg.height,
      bytes: buffer.length,
      ms: Date.now() - t0,
      prompt,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
