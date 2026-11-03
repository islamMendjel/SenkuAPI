// POST /api/chat/variant — persist one assistant message's answer
// variant history (regenerate) and/or its active variant. The active
// answer always lives in the message's own content/model columns so
// every existing reader (timeline, export, search) keeps working;
// `variants` holds the earlier ones as JSON.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { ImageRef } from "@/lib/senku/types";

export const dynamic = "force-dynamic";

interface VariantBody {
  content: unknown;
  model: unknown;
  tokens: unknown;
  cached: unknown;
  servedBy: unknown;
  keyLabel: unknown;
  effort: unknown;
  image?: unknown;
}

/** Narrow one forged-image reference inside a variant (Run 22). */
function toImage(v: unknown): ImageRef | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  if (
    typeof e.id !== "string" ||
    typeof e.width !== "number" ||
    typeof e.height !== "number"
  ) {
    return null;
  }
  return {
    id: e.id,
    mime: typeof e.mime === "string" ? e.mime : "image/jpeg",
    width: e.width,
    height: e.height,
    bytes: typeof e.bytes === "number" ? e.bytes : 0,
    ms: typeof e.ms === "number" ? e.ms : 0,
    prompt: typeof e.prompt === "string" ? e.prompt : "",
  };
}

/** Narrow one variant entry; drop anything that isn't a real
    answer — a malformed entry must never poison the JSON column.
    Image re-roll variants carry their ImageRef alongside the text
    marker content (Run 22). */
function toVariant(v: unknown): {
  content: string;
  model: string;
  tokens: number;
  cached: boolean;
  servedBy: string | null;
  keyLabel: string | null;
  effort: string | null;
  image?: ImageRef | null;
} | null {
  if (!v || typeof v !== "object") return null;
  const e = v as VariantBody;
  if (typeof e.content !== "string" || !e.content.trim()) return null;
  const image = toImage(e.image);
  return {
    content: e.content,
    model: typeof e.model === "string" ? e.model : "",
    tokens:
      typeof e.tokens === "number" && Number.isFinite(e.tokens)
        ? Math.max(0, Math.round(e.tokens))
        : 0,
    cached: e.cached === true,
    servedBy: typeof e.servedBy === "string" ? e.servedBy : null,
    keyLabel: typeof e.keyLabel === "string" ? e.keyLabel : null,
    effort:
      e.effort === "fast" || e.effort === "medium" || e.effort === "deep"
        ? e.effort
        : null,
    ...(image ? { image } : {}),
  };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const messageId = body.messageId as string | undefined;
  if (!messageId) {
    return NextResponse.json({ error: "messageId is required" }, { status: 400 });
  }

  const message = await db.message.findUnique({ where: { id: messageId } });
  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }

  const rawVariants = Array.isArray(body.variants) ? body.variants : [];
  const variants = rawVariants
    .map(toVariant)
    .filter((v): v is NonNullable<ReturnType<typeof toVariant>> => v !== null);

  if (variants.length === 0) {
    return NextResponse.json(
      { error: "variants must contain at least one valid answer" },
      { status: 400 }
    );
  }

  const variantIndexRaw =
    typeof body.variantIndex === "number" && Number.isInteger(body.variantIndex)
      ? body.variantIndex
      : variants.length - 1;
  const variantIndex = Math.min(
    Math.max(variantIndexRaw, 0),
    variants.length - 1
  );
  const active = variants[variantIndex];

  await db.message.update({
    where: { id: messageId },
    data: {
      variants: JSON.stringify(variants),
      variantIndex,
      // The active variant is the message truth — content/model (and
      // its receipt) always mirror it, for every downstream reader.
      // (servedBy is runtime-only provenance — it lives inside the
      // variants JSON, never as a column.) Image re-rolls mirror
      // their active ImageRef the same way (Run 22).
      content: active.content,
      model: active.model || message.model,
      tokens: active.tokens,
      cached: active.cached,
      keyLabel: active.keyLabel,
      effort: active.effort,
      image: active.image ? JSON.stringify(active.image) : null,
    },
  });
  await db.chat.update({
    where: { id: message.chatId },
    data: { updatedAt: new Date() },
  });

  return NextResponse.json({
    ok: true,
    variantIndex,
    variants: variants.length,
  });
}
