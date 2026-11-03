// POST /api/image/generate — Run 22 Image Forge.
// Turns a prompt into a real image via the Z.ai image engine
// (server-side SDK), persists the turn for saved chats, and answers
// with a self-contained ImageRef. The engine needs 30–90s — the
// client keeps the request open and shows a live generating card.
//
// Persistence mirrors the text turn contract:
//   user row      — content = prompt (created only when persistUser)
//   assistant row — content = text marker (search/export/history),
//                   image = JSON ImageRef, model = "image-forge",
//                   servedBy = "zai-cloud", tokens = 0 (the forge
//                   never touches the pooled keys — provenance says so)
// Re-rolls arrive with regenVariants (earlier images included) and
// are written in the same single insert — no second round-trip.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { deriveTitle } from "@/lib/hermes/gateway";
import { discardImageFile, forgeImage } from "@/lib/hermes/imagegen";
import { IMAGE_SIZE_KEYS } from "@/lib/hermes/image-forge";
import { ensureSeed } from "@/lib/hermes/seed";
import type { ImageRef, ImageSize } from "@/lib/hermes/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface GenerateBody {
  chatId?: unknown;
  prompt?: unknown;
  size?: unknown;
  temporary?: unknown;
  persistUser?: unknown;
  regenVariants?: unknown;
}

/** Narrow one re-roll variant entry — same shape the variant route
 *  persists, plus the image it must carry. */
function toRegenVariant(v: unknown):
  | {
      content: string;
      model: string;
      tokens: number;
      cached: boolean;
      servedBy: string | null;
      keyLabel: string | null;
      effort: string | null;
      image: ImageRef | null;
    }
  | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  if (typeof e.content !== "string") return null;
  const img =
    e.image && typeof e.image === "object"
      ? (e.image as Record<string, unknown>)
      : null;
  const image: ImageRef | null =
    img &&
    typeof img.id === "string" &&
    typeof img.width === "number" &&
    typeof img.height === "number"
      ? {
          id: img.id,
          mime: typeof img.mime === "string" ? img.mime : "image/jpeg",
          width: img.width,
          height: img.height,
          bytes: typeof img.bytes === "number" ? img.bytes : 0,
          ms: typeof img.ms === "number" ? img.ms : 0,
          prompt: typeof img.prompt === "string" ? img.prompt : "",
        }
      : null;
  return {
    content: e.content,
    model: typeof e.model === "string" ? e.model : "image-forge",
    tokens: 0,
    cached: false,
    servedBy: typeof e.servedBy === "string" ? e.servedBy : null,
    keyLabel: typeof e.keyLabel === "string" ? e.keyLabel : null,
    effort: null,
    image,
  };
}

export async function POST(req: NextRequest) {
  await ensureSeed();
  const body = (await req.json().catch(() => ({}))) as GenerateBody;

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }
  if (prompt.length > 2000) {
    return NextResponse.json(
      { error: "Prompt too long — keep image prompts under 2000 characters." },
      { status: 400 }
    );
  }
  const size: ImageSize = IMAGE_SIZE_KEYS.includes(body.size as ImageSize)
    ? (body.size as ImageSize)
    : "square";
  const temporary = body.temporary === true;
  const persistUser = body.persistUser !== false;
  const regenVariants = Array.isArray(body.regenVariants)
    ? (body.regenVariants
        .map(toRegenVariant)
        .filter((v) => v !== null) as NonNullable<ReturnType<typeof toRegenVariant>>[])
    : [];

  // ── 1. Chat + user row (mirrors the text turn contract) ──
  let chatId = typeof body.chatId === "string" && body.chatId ? body.chatId : null;
  let userMessageId: string | null = null;
  let title: string | null = null;

  if (!temporary && persistUser) {
    if (!chatId) {
      title = deriveTitle(prompt);
      const chat = await db.chat.create({
        data: { title, model: "image-forge", provider: "Z.ai cloud", isTemporary: false },
      });
      chatId = chat.id;
    }
    const userMsg = await db.message.create({
      data: { chatId, role: "user", content: prompt },
    });
    userMessageId = userMsg.id;
  } else if (!temporary && chatId) {
    // Re-roll: the user row already exists — keep the chat fresh only.
    await db.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() },
    }).catch(() => {});
  }

  // ── 2. The forge (slow — 30–90s) ──
  let image: ImageRef;
  try {
    image = await forgeImage(prompt, size);
  } catch (e) {
    const err = e as Error;
    return NextResponse.json(
      {
        error: `Image generation failed — ${err.message || "the engine is busy. Try again."}`,
        chatId,
        userMessageId,
        title,
      },
      { status: 502 }
    );
  }

  // The client hung up mid-forge (Stop / navigation): the turn dies
  // exactly like a stopped text turn — user row stays (if persisted),
  // no assistant row, and the orphan file is removed.
  if (req.signal.aborted) {
    discardImageFile(image.id);
    return NextResponse.json({ ok: false, aborted: true, chatId });
  }

  // ── 3. Assistant row (marker content + image ref + variants) ──
  const marker = `Generated image — “${prompt.slice(0, 160)}${prompt.length > 160 ? "…" : ""}” (${image.width}×${image.height})`;
  let assistantMessageId: string | null = null;
  if (!temporary && chatId) {
    const variants =
      regenVariants.length > 0
        ? [
            ...regenVariants,
            {
              content: marker,
              model: "image-forge",
              tokens: 0,
              cached: false,
              servedBy: "zai-cloud",
              keyLabel: null,
              effort: null,
              image,
            },
          ]
        : null;
    const msg = await db.message.create({
      data: {
        chatId,
        role: "assistant",
        content: marker,
        model: "image-forge",
        provider: "Z.ai cloud",
        keyLabel: null,
        tokens: 0,
        cached: false,
        image: JSON.stringify(image),
        ...(variants
          ? { variants: JSON.stringify(variants), variantIndex: variants.length - 1 }
          : {}),
      },
    });
    assistantMessageId = msg.id;
    await db.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() },
    });
  }

  return NextResponse.json({
    ok: true,
    chatId,
    userMessageId,
    assistantMessageId,
    title,
    content: marker,
    image,
  });
}
