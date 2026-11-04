// POST /api/voice/jarvis — Autonomous Voice Core Directive Dispatcher.
// Dispatches spoken queries through the Exocore ReAct agent, Jev ensemble decision arbitrator,
// or Core Gateway, returning clean speakable text and rich markdown.

import { NextRequest, NextResponse } from "next/server";
import { JarvisDispatcher } from "@/services/voice/jarvis";
import { ensureSeed } from "@/lib/hermes/seed";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    await ensureSeed();
    const body = (await req.json().catch(() => ({}))) as { query?: string; transcript?: string };
    const query = (body.query ?? body.transcript ?? "").trim();

    if (!query) {
      return NextResponse.json(
        {
          spokenText: "I did not catch that. How can I assist you?",
          markdownText: "No speech recognized.",
          durationMs: 0,
        },
        { status: 200 }
      );
    }

    const outcome = await JarvisDispatcher.handleSpokenDirective(query);
    return NextResponse.json(outcome);
  } catch (err) {
    const error = err as Error;
    console.error("[Jarvis API] Error handling directive:", error);
    return NextResponse.json(
      {
        spokenText: "I encountered an error executing that directive.",
        markdownText: `**Error:** ${error.message || "Execution failure"}`,
        durationMs: 0,
      },
      { status: 500 }
    );
  }
}
