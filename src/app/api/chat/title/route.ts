// POST /api/chat/title — replace a chat's raw derived title
// ("who r u?") with a proper one from a cheap cloud model pass
// ("Who Are You?"). Reads the chat's first user message from the
// DB itself, so it works both for brand-new chats and for
// back-filling old raw-titled ones.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { zaiCloudExec } from "@/lib/hermes/executor";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const TITLE_SYSTEM =
  "You write ultra-short chat titles. Reply with ONLY the title: " +
  "2 to 5 words, Title Case, no quotes, no trailing punctuation, no emoji. " +
  "Describe what the user is asking about, fixing typos and texting " +
  "abbreviations (e.g. \"who r u?\" → \"Who Are You\", \"what today date " +
  "month year and\" → \"Current Date Question\").";

function cleanTitle(raw: string): string {
  let t = raw.trim();
  // the model sometimes wraps the title in quotes or backticks
  t = t.replace(/^["'`«»\s]+|["'`«»\s]+$/g, "");
  t = t.split("\n")[0] ?? "";
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(/[.!?…]+$/, "");
  if (t.length > 48) t = t.slice(0, 48).trimEnd() + "…";
  return t;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { chatId?: string };
  const chatId = (body.chatId ?? "").trim();
  if (!chatId) {
    return NextResponse.json({ error: "chatId is required" }, { status: 400 });
  }

  const chat = await db.chat.findUnique({ where: { id: chatId } });
  if (!chat || chat.isTemporary) {
    return NextResponse.json({ error: "chat not found" }, { status: 404 });
  }

  const firstUser = await db.message.findFirst({
    where: { chatId, role: "user" },
    orderBy: { createdAt: "asc" },
  });
  if (!firstUser) {
    return NextResponse.json(
      { error: "chat has no user message" },
      { status: 400 }
    );
  }

  try {
    // Cheap model pass: thinking disabled, tiny prompt, no streaming.
    const exec = await zaiCloudExec({
      baseUrl: null,
      apiKey: "",
      model: "",
      messages: [
        { role: "system", content: TITLE_SYSTEM },
        { role: "user", content: firstUser.content.slice(0, 600) },
      ],
    });
    const title = cleanTitle(exec.content);
    if (!title) {
      return NextResponse.json({ title: chat.title });
    }
    await db.chat.update({ where: { id: chatId }, data: { title } });
    return NextResponse.json({ title });
  } catch {
    // generation failed — keep the derived title, never 500
    return NextResponse.json({ title: chat.title });
  }
}
