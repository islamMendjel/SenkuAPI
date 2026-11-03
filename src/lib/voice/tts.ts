// Hermes — server-side voice helpers for the Read-Aloud (TTS) pipeline.
// Markdown → speakable text → ≤900-char sentence chunks → one WAV per
// chunk → concatenated into a single streamable WAV. Results are cached
// in memory (LRU, 24 entries) so replaying a message is instant and free.

import { createHash } from "crypto";

export const TTS_VOICE = "jam"; // British gentleman — best English delivery
export const TTS_SPEED = 1.0;
export const CHUNK_MAX_CHARS = 900; // SDK hard limit is 1024; leave headroom
export const CHUNK_HARD_CAP = 4; // at most 4 chunks (~3600 chars) per reply

// ── 1. Markdown → speakable prose ────────────────────────────
export function markdownToSpeech(md: string): string {
  let t = md;

  // fenced code blocks → a short spoken cue
  t = t.replace(/```[\s\S]*?```/g, " … a code block … ");
  // inline code → keep the content, drop the backticks
  t = t.replace(/`([^`]+)`/g, "$1");
  // images → drop entirely
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // links → keep the label only
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // headings / blockquotes / list markers → plain words
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  t = t.replace(/^\s{0,3}>\s?/gm, "");
  t = t.replace(/^\s*[-*+]\s+/gm, "");
  t = t.replace(/^\s*\d+\.\s+/gm, "");
  // tables → keep cell text
  t = t.replace(/\|/g, " ");
  t = t.replace(/^\s*[-:| -]+$/gm, "");
  // emphasis markers
  t = t.replace(/(\*\*|__|\*|_|~~)/g, "");
  // citations like [example.com]
  t = t.replace(/\[[^\]]+\]/g, "");
  // collapse whitespace
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

// ── 2. Sentence-aware chunking under the SDK limit ───────────
export function chunkForTts(text: string, max = CHUNK_MAX_CHARS): string[] {
  if (text.length <= max) return [text];

  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let cur = "";

  for (const s of sentences) {
    const sentence = s.trim();
    if (!sentence) continue;
    // a single monster sentence → hard-split it
    if (sentence.length > max) {
      if (cur) {
        chunks.push(cur.trim());
        cur = "";
      }
      for (let i = 0; i < sentence.length; i += max) {
        chunks.push(sentence.slice(i, i + max).trim());
      }
      continue;
    }
    if ((cur + " " + sentence).trim().length > max) {
      if (cur) chunks.push(cur.trim());
      cur = sentence;
    } else {
      cur = (cur + " " + sentence).trim();
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.slice(0, CHUNK_HARD_CAP);
}

// ── 3. WAV concatenation (same codec → merge PCM payloads) ──
// Parses the RIFF header of each chunk, extracts the "data" payload,
// then rebuilds one clean header around the joined PCM.
export function mergeWavBuffers(buffers: Buffer[]): Buffer {
  if (buffers.length === 0) throw new Error("no audio to merge");
  if (buffers.length === 1) return buffers[0];

  const pcmParts: Buffer[] = [];
  let sampleRate = 24000;
  let bitsPerSample = 16;
  let channels = 1;

  for (const buf of buffers) {
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") continue;
    // walk chunks to find fmt + data
    let off = 12;
    let dataOff = -1;
    let dataLen = 0;
    while (off + 8 <= buf.length) {
      const id = buf.toString("ascii", off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === "fmt ") {
        channels = buf.readUInt16LE(off + 10);
        sampleRate = buf.readUInt32LE(off + 12);
        bitsPerSample = buf.readUInt16LE(off + 22);
      } else if (id === "data") {
        dataOff = off + 8;
        dataLen = Math.min(size, buf.length - dataOff);
        break;
      }
      off += 8 + size + (size % 2);
    }
    if (dataOff > 0 && dataLen > 0) {
      pcmParts.push(buf.subarray(dataOff, dataOff + dataLen));
    }
  }

  if (!pcmParts.length) return buffers[0];

  const pcm = Buffer.concat(pcmParts);
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

// ── 4. LRU cache for generated speech ────────────────────────
const CACHE_MAX = 24;
const ttsCache = new Map<string, Buffer>();

export function ttsCacheKey(text: string, voice: string): string {
  return createHash("sha1").update(`${voice}::${text}`).digest("hex");
}

export function ttsCacheGet(key: string): Buffer | null {
  const hit = ttsCache.get(key);
  if (hit) {
    // refresh recency
    ttsCache.delete(key);
    ttsCache.set(key, hit);
  }
  return hit ?? null;
}

export function ttsCachePut(key: string, audio: Buffer): void {
  if (ttsCache.has(key)) ttsCache.delete(key);
  ttsCache.set(key, audio);
  if (ttsCache.size > CACHE_MAX) {
    const oldest = ttsCache.keys().next().value;
    if (oldest) ttsCache.delete(oldest);
  }
}
