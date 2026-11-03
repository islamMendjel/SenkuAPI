// GET  /api/rituals — list every scheduled ritual (with chat titles)
// POST /api/rituals — schedule one: dedicated chat + first due time
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { RITUAL_MAX_ENTRIES } from "@/lib/hermes/constants";
import { getActiveProvider } from "@/lib/hermes/router";
import { ensureSeed } from "@/lib/hermes/seed";
import {
  computeNextRun,
  ritualView,
  sanitizeRitualInput,
} from "@/lib/hermes/ritual";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeed();
  const rows = await db.ritual.findMany({
    orderBy: { createdAt: "asc" },
    include: { chat: { select: { title: true } } },
  });
  return NextResponse.json({
    rituals: rows.map((r) => ritualView(r, r.chat.title)),
  });
}

export async function POST(req: NextRequest) {
  await ensureSeed();
  const body = await req.json().catch(() => ({}));

  try {
    const count = await db.ritual.count();
    if (count >= RITUAL_MAX_ENTRIES) {
      return NextResponse.json(
        {
          error: `Ritual cap reached (${RITUAL_MAX_ENTRIES}) — remove one to schedule another.`,
          code: "cap",
        },
        { status: 400 }
      );
    }

    const input = sanitizeRitualInput(body);

    // The dedicated chat: every run of this ritual lands here. The
    // model/provider columns sync on the first run (the gateway
    // stamps what actually served), like any other chat.
    const provider = await getActiveProvider();
    const chat = await db.chat.create({
      data: {
        title: input.title,
        model: JSON.parse(provider.models || "[]")[0] ?? "free/glm-5.3",
        provider: provider.name,
        isTemporary: false,
      },
    });

    const ritual = await db.ritual.create({
      data: {
        title: input.title,
        prompt: input.prompt,
        chatId: chat.id,
        kind: input.kind,
        hour: input.hour,
        minute: input.minute,
        weekday: input.weekday,
        intervalMin: input.intervalMin,
        search: input.search,
        isActive: true,
        nextRunAt: computeNextRun(
          input.kind,
          input.hour,
          input.minute,
          input.weekday,
          input.intervalMin
        ),
      },
      include: { chat: { select: { title: true } } },
    });

    return NextResponse.json({ ritual: ritualView(ritual, ritual.chat.title) });
  } catch (e) {
    const err = e as Error & { code?: string };
    return NextResponse.json(
      { error: err.message, code: err.code ?? "error" },
      { status: 400 }
    );
  }
}
