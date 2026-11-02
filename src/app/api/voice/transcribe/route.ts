// POST /api/voice/transcribe — dictation: browser-recorded WAV (base64)
// → cloud ASR → text. The client always uploads 16 kHz mono WAV (encoded
// in-browser from the MediaRecorder blob), which the ASR service accepts
// in every browser — no reliance on the flaky Web Speech API.
import { NextRequest } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_AUDIO_BYTES = 12 * 1024 * 1024; // ~12MB base64 payload guard

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { audio?: string };
    const base64 = (body.audio ?? "").trim();
    if (!base64) {
      return Response.json({ error: "audio is required" }, { status: 400 });
    }
    if (base64.length > MAX_AUDIO_BYTES) {
      return Response.json({ error: "recording is too long" }, { status: 413 });
    }

    const zai = await ZAI.create();
    const res = await zai.audio.asr.create({ file_base64: base64 });
    const text = (res?.text ?? "").trim();

    return Response.json({ text });
  } catch (e) {
    const err = e as Error;
    console.error("voice/transcribe failed:", err.message);
    return Response.json(
      { error: "Transcription failed — please try again." },
      { status: 500 }
    );
  }
}
