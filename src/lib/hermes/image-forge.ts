// Hermes — Run 22 Image Forge: client-safe constants.
// The size table + id validation are shared by the composer (pick a
// size), the timeline (badges) and the server (engine call, file
// serving). No SDK imports here — this module is bundled for the
// client too.

import type { ImageSize } from "./types";

/** The four forge dimensions, each mapped onto an engine-supported
 *  size. `hint` is the picker's honest guidance, not marketing. */
export const IMAGE_SIZES: Record<
  ImageSize,
  { label: string; dims: string; width: number; height: number; hint: string }
> = {
  square: {
    label: "Square",
    dims: "1024x1024",
    width: 1024,
    height: 1024,
    hint: "Icons, emblems, avatars",
  },
  portrait: {
    label: "Portrait",
    dims: "768x1344",
    width: 768,
    height: 1344,
    hint: "Posters, phone wallpapers",
  },
  landscape: {
    label: "Landscape",
    dims: "1344x768",
    width: 1344,
    height: 768,
    hint: "Covers, scenes",
  },
  wide: {
    label: "Wide",
    dims: "1440x720",
    width: 1440,
    height: 720,
    hint: "Banners, headers",
  },
};

export const IMAGE_SIZE_KEYS = Object.keys(IMAGE_SIZES) as ImageSize[];

/** Map a forged image's pixel dimensions back onto a size key — used
 *  when re-rolling a restored message whose user bubble no longer
 *  carries its in-memory request info. */
export function sizeFromDims(
  width: number,
  height: number
): ImageSize | null {
  for (const key of IMAGE_SIZE_KEYS) {
    const s = IMAGE_SIZES[key];
    if (s.width === width && s.height === height) return key;
  }
  return null;
}

/** Forged file ids: "img-<base36 time>-<rand>.<jpg|png>". Strict
 *  pattern = no directory traversal, no extension games. */
const IMAGE_ID_RE = /^img-[a-z0-9]+-[a-z0-9]{6,12}\.(jpg|png)$/;

export function isValidImageId(id: string): boolean {
  return IMAGE_ID_RE.test(id);
}

export function mimeOfImageId(id: string): string {
  return id.endsWith(".png") ? "image/png" : "image/jpeg";
}
