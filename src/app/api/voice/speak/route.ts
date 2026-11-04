// POST /api/voice/speak — Read-Aloud endpoint.
import { NextRequest } from "next/server";
import {
  TTS_SPEED,
  TTS_VOICE,
  chunkForTts,
  markdownToSpeech,
  mergeWavBuffers,
  ttsCacheGet,
  ttsCacheKey,
  ttsCachePut,
} from "@/lib/voice/tts";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_INPUT_CHARS = 6000;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { text?: string };
    const md = (body.text ?? "").trim();
    if (!md) {
      return Response.json({ error: "text is required" }, { status: 400 });
    }
    if (md.length > MAX_INPUT_CHARS) {
      return Response.json({ error: "text is too long to read aloud" }, { status: 413 });
    }

    const speakable = markdownToSpeech(md);
    if (!speakable) {
      return Response.json({ error: "nothing speakable in this message" }, { status: 400 });
    }

    const key = ttsCacheKey(speakable, TTS_VOICE);
    const cached = ttsCacheGet(key);
    if (cached) {
      return new Response(new Uint8Array(cached), {
        headers: {
          "Content-Type": "audio/wav",
          "Content-Length": String(cached.length),
          "X-Speech-Cache": "hit",
          "Cache-Control": "no-store",
        },
      });
    }

    // Return 503 so client uses high-speed browser Web SpeechSynthesis
    return Response.json(
      { error: "Server TTS unavailable — using browser voice synthesis." },
      { status: 503 }
    );
  } catch (e) {
    const err = e as Error;
    console.error("voice/speak failed:", err.message);
    return Response.json(
      { error: "Read-aloud is unavailable right now." },
      { status: 500 }
    );
  }
}
