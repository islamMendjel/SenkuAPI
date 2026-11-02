// POST /api/voice/speak — Read-Aloud: markdown text → merged spoken WAV.
// Chunks long answers, synthesizes each with the cloud TTS, concatenates
// into one WAV and serves it as audio/wav. Cached in memory (LRU) so a
// second play of the same message is instant and costs zero TTS calls.
import { NextRequest } from "next/server";
import ZAI from "z-ai-web-dev-sdk";
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

    const chunks = chunkForTts(speakable);
    const zai = await ZAI.create();

    const buffers: Buffer[] = [];
    for (const chunk of chunks) {
      const res = await zai.audio.tts.create({
        input: chunk,
        voice: TTS_VOICE,
        speed: TTS_SPEED,
        response_format: "wav",
        stream: false,
      });
      const arrayBuffer = await res.arrayBuffer();
      const buf = Buffer.from(new Uint8Array(arrayBuffer));
      if (buf.length > 44) buffers.push(buf);
    }

    if (!buffers.length) {
      return Response.json({ error: "TTS returned no audio" }, { status: 502 });
    }

    const wav = mergeWavBuffers(buffers);
    ttsCachePut(key, wav);

    return new Response(new Uint8Array(wav), {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(wav.length),
        "X-Speech-Cache": "miss",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const err = e as Error;
    console.error("voice/speak failed:", err.message);
    return Response.json(
      { error: "Read-aloud is unavailable right now." },
      { status: 500 }
    );
  }
}
