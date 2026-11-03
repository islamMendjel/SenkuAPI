// POST /api/chat/duel/pick — persist the winner of a duel turn.
//
// A duel streams two lanes but persists nothing assistant-side until
// the user picks. This endpoint stores the WINNING lane as the chat's
// assistant message and keeps the losing lane as a viewable runner-up
// (Message.altContent / altModel). Usage accounting already happened
// at generation time — both lanes were honestly billed for what they
// served; the pick only decides what the conversation remembers.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getActiveProvider } from "@/lib/hermes/router";
import { ensureSeed } from "@/lib/hermes/seed";
import { advanceLeaf, currentLeaf, nextChildSlot } from "@/lib/hermes/tree";

export const dynamic = "force-dynamic";

interface LaneBody {
  content?: string;
  model?: string;
  tokens?: number;
  cached?: boolean;
  servedBy?: string;
  keyLabel?: string | null;
}

interface PickBody {
  chatId?: string;
  winner?: LaneBody;
  runnerUp?: { content?: string; model?: string } | null;
  effort?: "fast" | "medium" | "deep";
}

const MAX_CONTENT = 100_000;

export async function POST(req: NextRequest) {
  await ensureSeed();
  const body = (await req.json().catch(() => ({}))) as PickBody;

  const chatId = typeof body.chatId === "string" ? body.chatId : "";
  const winner = body.winner ?? {};
  const content = (winner.content ?? "").trim();
  const model = (winner.model ?? "").trim();

  if (!chatId || !content || !model) {
    return NextResponse.json(
      { error: "chatId, winner.content and winner.model are required" },
      { status: 400 }
    );
  }
  if (content.length > MAX_CONTENT) {
    return NextResponse.json(
      { error: "winner content exceeds the size limit" },
      { status: 400 }
    );
  }
  const runnerUpContent = (body.runnerUp?.content ?? "").trim();
  const runnerUpModel = (body.runnerUp?.model ?? "").trim();
  if (runnerUpContent.length > MAX_CONTENT) {
    return NextResponse.json(
      { error: "runner-up content exceeds the size limit" },
      { status: 400 }
    );
  }

  const chat = await db.chat.findUnique({ where: { id: chatId } });
  if (!chat) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }

  const provider = await getActiveProvider();
  const servedBy =
    winner.servedBy === "zai-cloud"
      ? "zai-cloud"
      : winner.servedBy === "cache"
        ? "cache"
        : "provider";

  // Provenance is preserved exactly as the lane reported it — a
  // cache-hit winner records 0 tokens + cached, a cloud-failover
  // winner records no key. The pick never rewrites history.
  // Run 39 — the winner chains to the duel turn's user row (which is
  // the displayed leaf — no assistant row landed for this turn yet).
  const slot = await nextChildSlot(chatId, (await currentLeaf(chatId)).id);
  const msg = await db.message.create({
    data: {
      chatId,
      role: "assistant",
      content,
      model,
      provider: provider.name,
      keyLabel:
        typeof winner.keyLabel === "string" && winner.keyLabel
          ? winner.keyLabel
          : null,
      tokens:
        typeof winner.tokens === "number"
          ? Math.max(0, Math.round(winner.tokens))
          : 0,
      cached: winner.cached === true,
      effort: body.effort ?? null,
      altContent: runnerUpContent || null,
      altModel: runnerUpModel || null,
      parentMessageId: slot.parentMessageId,
      branchIndex: slot.branchIndex,
    },
  });
  await advanceLeaf(chatId, msg.id);

  await db.chat.update({
    where: { id: chatId },
    data: { updatedAt: new Date(), model, provider: provider.name },
  });

  return NextResponse.json({ id: msg.id });
}
