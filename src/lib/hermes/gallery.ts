// Hermes — Run 23 THE GALLERY (server side).
// Every image the forge ever produced, across every saved chat: the
// active ImageRef of each message PLUS the images snapshotted inside
// re-roll variant histories — a re-rolled image is still an image the
// user paid wait-time for, so it stays visible until its chat dies.
// Files are verified on disk before listing: an image whose bytes are
// gone is never shown (no broken cards, no guessed thumbnails).
// Temporary chats never write DB rows, so they never appear — same
// contract as chats history.

import fs from "fs";
import { db } from "@/lib/db";
import { imageFilePath } from "./imagegen";
import type { GalleryItem, ImageRef } from "./types";

/** Hard caps for the personal-gateway scale: the 300 newest images
 * from the 500 most recent image-bearing messages. */
const MAX_MESSAGES = 500;
const MAX_IMAGES = 300;

function parseMaybeJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function isImageRef(v: unknown): v is ImageRef {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as ImageRef).id === "string" &&
    typeof (v as ImageRef).width === "number" &&
    typeof (v as ImageRef).height === "number" &&
    typeof (v as ImageRef).prompt === "string"
  );
}

/** Variant entries as persisted by the regenerate flow (Run 21/22):
 * `{content, model, tokens, …, image?: ImageRef}`. */
interface VariantRow {
  image?: unknown;
}

/** All gallery images, newest first. Each entry pairs the ImageRef
 * with its birth chat so the UI can offer "open in chat". */
export async function listGalleryImages(): Promise<GalleryItem[]> {
  const rows = await db.message.findMany({
    where: { image: { not: null } },
    orderBy: { createdAt: "desc" },
    take: MAX_MESSAGES,
    select: {
      id: true,
      createdAt: true,
      image: true,
      variants: true,
      chat: { select: { id: true, title: true } },
    },
  });

  const out: GalleryItem[] = [];
  for (const row of rows) {
    const createdAt = row.createdAt.toISOString();
    const chatTitle = row.chat.title;
    const chatId = row.chat.id;

    // Active image first (it's the current answer of its turn), then
    // the re-rolled snapshots in reverse order (newest variant first).
    const active = parseMaybeJson<unknown>(row.image);
    const variants = parseMaybeJson<VariantRow[]>(row.variants) ?? [];
    const candidates: unknown[] = [
      active,
      ...[...variants].reverse().map((v) => v?.image),
    ];

    // ONE FILE → ONE TILE. Flipping a re-rolled answer back and forth
    // mirrors the same ImageRef into the active slot AND a variant
    // slot (Run 22's variant mirror) — the gallery keys and counts
    // files, not slots, so duplicates collapse (the active slot wins).
    const seen = new Set<string>();
    for (const cand of candidates) {
      if (!isImageRef(cand)) continue;
      if (seen.has(cand.id)) continue;
      seen.add(cand.id);
      // Honest listing: only images whose bytes actually exist.
      if (!fs.existsSync(imageFilePath(cand.id))) continue;
      out.push({
        key: `${row.id}:${cand.id}`,
        chatId,
        chatTitle,
        createdAt,
        image: cand,
      });
      if (out.length >= MAX_IMAGES) break;
    }
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}
