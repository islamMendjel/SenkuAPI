// Senku Voice Service (Microservice Domain Entrypoint)
// Audio WAV serialization, Text-to-Speech caching, and Jarvis voice core.

import { JarvisDispatcher, formatForSpeech, type JarvisState, type JarvisDispatchResult } from "./jarvis";
import { blobToWavBase64 } from "@/lib/voice/audio";
import {
  TTS_VOICE,
  TTS_SPEED,
  chunkForTts,
  markdownToSpeech,
  ttsCacheGet,
  ttsCachePut,
} from "@/lib/voice/tts";

export * from "./jarvis";
export {
  JarvisDispatcher,
  formatForSpeech,
  blobToWavBase64,
  TTS_VOICE,
  TTS_SPEED,
  chunkForTts,
  markdownToSpeech,
  ttsCacheGet,
  ttsCachePut,
  type JarvisState,
  type JarvisDispatchResult,
};
