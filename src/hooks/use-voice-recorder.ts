"use client";

// SenkuAPI — useVoiceRecorder: microphone capture with live level
// analysis for the waveform UI. Records via MediaRecorder, then hands
// back a 16 kHz mono WAV base64 (see lib/voice/audio.ts) ready for the
// /api/voice/transcribe endpoint. Works in every modern browser —
// no Web Speech API dependency.

import { useCallback, useEffect, useRef, useState } from "react";

export type RecorderState = "idle" | "requesting" | "recording" | "processing";

export interface VoiceRecorder {
  state: RecorderState;
  elapsedMs: number;
  error: string | null;
  /** rAF-driven level updates land here — read inside your animation loop */
  levelRef: React.MutableRefObject<number>;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  /** resolves with wav base64 when a recording completes ("stop" was called) */
  takeResult: () => Promise<string | null>;
}

const MAX_MS = 60_000; // hard cap: 60 seconds of dictation

export function useVoiceRecorder(): VoiceRecorder {
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const levelRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);

  const cleanup = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    try {
      recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* noop */
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    levelRef.current = 0;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(async () => {
    setError(null);
    cancelledRef.current = false;
    setState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // live level meter (for the waveform strip)
      const AudioCtx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);

      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        levelRef.current = levelRef.current * 0.7 + Math.min(1, rms * 4) * 0.3;
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);

      // pick a mime the browser actually supports
      const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/mp4",
        "",
      ];
      const mimeType =
        candidates.find(
          (c) => !c || (typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(c))
        ) ?? "";

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start(250);
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setState("recording");

      timerRef.current = setInterval(() => {
        const ms = Date.now() - startedAtRef.current;
        setElapsedMs(ms);
        if (ms >= MAX_MS) stop(); // auto-stop at the cap
      }, 100);
    } catch (e) {
      cleanup();
      setState("idle");
      const err = e as Error;
      setError(
        err.name === "NotAllowedError"
          ? "Microphone access was denied."
          : err.name === "NotFoundError"
            ? "No microphone was found."
            : "Could not start recording."
      );
    }
  }, [cleanup]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    setState("processing");
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    recorder.stop(); // onstop fires below via the recorded flag
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    try {
      recorderRef.current?.stop();
    } catch {
      /* noop */
    }
    cleanup();
    setState("idle");
    setElapsedMs(0);
  }, [cleanup]);

  const takeResult = useCallback(async (): Promise<string | null> => {
    if (cancelledRef.current) return null;
    // wait for the recorder to flush its final data
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        recorder.addEventListener("stop", done, { once: true });
        setTimeout(done, 1500); // safety valve
      });
    }
    const blob = new Blob(chunksRef.current, { type: recorder?.mimeType || "audio/webm" });
    cleanup();
    setElapsedMs(0);
    setState("idle");
    if (blob.size < 800) return null; // effectively empty
    const { blobToWavBase64 } = await import("@/lib/voice/audio");
    return blobToWavBase64(blob);
  }, [cleanup]);

  return { state, elapsedMs, error, levelRef, start, stop, cancel, takeResult };
}
