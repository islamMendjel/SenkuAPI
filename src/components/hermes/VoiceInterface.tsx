"use client";

// Hermes — Run 40: H.E.R.M.E.S. VOICE — the full-screen voice
// conversation overlay. THE JARVIS LAYER:
//
//   tap the orb  →  listen (live level pulse)
//   tap again    →  transcribe → SEND (same pipeline as typing)
//   reply lands  →  SPOKEN ALOUD via the cloud TTS (/api/voice/speak)
//   playback end →  back to listening — hands-free, both directions
//
// Rules honored from the dictation work (Run 33/38): the recorder's
// deferred onstop flush is awaited before the WAV is built, an empty
// recording bounces back to listening (never a phantom send), and a
// tap during "thinking" stops generation (never a stuck overlay).
// Muted mode keeps the conversation going without speech; ESC closes
// everything cleanly; reduced-motion users get a calm orb.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioWaveform,
  Brain,
  Loader2,
  Mic,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useHermes } from "@/lib/store";
import { useVoiceRecorder } from "@/hooks/use-voice-recorder";
import { useToast } from "@/hooks/use-toast";

type VoicePhase = "listening" | "transcribing" | "thinking" | "speaking";

const CAPTIONS: Record<VoicePhase, string> = {
  listening: "Listening — tap the orb to send",
  transcribing: "Transcribing…",
  thinking: "Thinking — tap the orb to interrupt",
  speaking: "Speaking — tap to interrupt",
};

export function VoiceInterface() {
  const setVoiceMode = useHermes((s) => s.setVoiceMode);
  const voiceReply = useHermes((s) => s.voiceReply);
  const consumeVoiceReply = useHermes((s) => s.consumeVoiceReply);
  const streaming = useHermes((s) => s.streaming);

  const { state: recorderState, levelRef, start, stop, cancel, takeResult } =
    useVoiceRecorder();
  const { toast } = useToast();

  const [phase, setPhase] = useState<VoicePhase>("listening");
  const [muted, setMuted] = useState(false);
  const [lastHeard, setLastHeard] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const tokenRef = useRef(0);
  const mutedRef = useRef(false);
  const phaseRef = useRef<VoicePhase>("listening");
  const orbRef = useRef<HTMLDivElement>(null);
  // Browser SpeechRecognition fallback ref
  const recognitionRef = useRef<any>(null);
  const browserTranscriptRef = useRef<string>("");

  phaseRef.current = phase;
  mutedRef.current = muted;

  const startBrowserRecognition = useCallback(() => {
    if (typeof window === "undefined") return;
    const SpeechRec =
      (window as unknown as { SpeechRecognition?: any }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: any }).webkitSpeechRecognition;
    if (!SpeechRec) return;
    try {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // ignore
        }
      }
      const rec = new SpeechRec();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";
      rec.onresult = (e: any) => {
        let transcript = "";
        for (let i = 0; i < e.results.length; i++) {
          transcript += e.results[i][0].transcript;
        }
        browserTranscriptRef.current = transcript.trim();
      };
      rec.onerror = () => {
        // non-fatal fallback
      };
      recognitionRef.current = rec;
      rec.start();
    } catch {
      // non-fatal
    }
  }, []);

  const stopBrowserRecognition = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
    }
  }, []);

  // ── audio playback hygiene ──
  const stopAudio = useCallback(() => {
    tokenRef.current += 1;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  const backToListening = useCallback(() => {
    setPhase("listening");
    browserTranscriptRef.current = "";
    void start();
    startBrowserRecognition();
  }, [start, startBrowserRecognition]);

  const close = useCallback(() => {
    stopAudio();
    stopBrowserRecognition();
    cancel();
    setVoiceMode(false);
  }, [cancel, setVoiceMode, stopAudio, stopBrowserRecognition]);

  // ── open → listen immediately; close → clean everything ──
  useEffect(() => {
    void start();
    startBrowserRecognition();
    return () => {
      stopAudio();
      stopBrowserRecognition();
    };
  }, [start, startBrowserRecognition, stopAudio, stopBrowserRecognition]);

  // ESC always exits voice mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // ── the orb tap ──
  const onOrbClick = useCallback(async () => {
    const p = phaseRef.current;
    if (p === "speaking") {
      // interrupt playback → listen again
      stopAudio();
      backToListening();
      return;
    }
    if (p === "thinking") {
      // interrupt generation; the liveness effect returns to listening
      useHermes.getState().stopStreaming();
      return;
    }
    if (p !== "listening" || recorderState !== "recording") return;

    // listening → stop + transcribe + send (Run 38's direct pipeline)
    stop();
    stopBrowserRecognition();
    setPhase("transcribing");
    try {
      const wav = await takeResult();
      let text = "";

      // 1. Try server transcription
      if (wav) {
        try {
          const res = await fetch("/api/voice/transcribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audio: wav }),
          });
          if (res.ok) {
            const data = (await res.json().catch(() => ({}))) as {
              text?: string;
            };
            text = (data.text ?? "").trim();
          }
        } catch {
          // server transcribe failed — fall through to browser fallback
        }
      }

      // 2. Native browser SpeechRecognition fallback
      if (!text && browserTranscriptRef.current) {
        text = browserTranscriptRef.current;
      }

      if (!text) {
        toast({ description: "Didn't catch that — try again." });
        backToListening();
        return;
      }
      setLastHeard(text);
      setPhase("thinking");
      await useHermes.getState().sendMessage(text);
      // a speakable reply arrives through voiceReply; anything else
      // (error card / duel pick) falls back via the liveness effect
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        toast({
          description:
            (e as Error).message || "Transcription failed — try again.",
          variant: "destructive",
        });
      }
      backToListening();
    }
  }, [
    backToListening,
    recorderState,
    stop,
    stopAudio,
    stopBrowserRecognition,
    takeResult,
    toast,
  ]);

  // ── speak the reply the moment it lands ──
  useEffect(() => {
    if (!voiceReply) return;
    if (mutedRef.current) {
      consumeVoiceReply();
      backToListening();
      return;
    }
    const token = ++tokenRef.current;
    setPhase("speaking");
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/voice/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: voiceReply.content }),
        });
        if (!res.ok) {
          throw new Error("Server voice synthesis unavailable.");
        }
        if (cancelled || token !== tokenRef.current) return;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        audioUrlRef.current = url;
        const audio = (audioRef.current ??= new Audio());
        audio.src = url;
        audio.onended = () => {
          if (token === tokenRef.current && !cancelled) {
            consumeVoiceReply();
            backToListening();
          }
        };
        audio.onerror = () => {
          if (token === tokenRef.current && !cancelled) {
            consumeVoiceReply();
            backToListening();
          }
        };
        await audio.play();
        if (token !== tokenRef.current || cancelled) return;
        consumeVoiceReply(); // playback started — the queue is clear
      } catch {
        // Fallback to client-side browser Web Speech Synthesis
        if (!cancelled && token === tokenRef.current) {
          if (typeof window !== "undefined" && "speechSynthesis" in window) {
            const cleanText = voiceReply.content
              .replace(/```[\s\S]*?```/g, "Code snippet omitted.")
              .replace(/[#*`_~[\]()]/g, "")
              .trim();
            if (cleanText) {
              const utterance = new SpeechSynthesisUtterance(cleanText);
              utterance.onend = () => {
                if (token === tokenRef.current && !cancelled) {
                  consumeVoiceReply();
                  backToListening();
                }
              };
              utterance.onerror = () => {
                if (token === tokenRef.current && !cancelled) {
                  consumeVoiceReply();
                  backToListening();
                }
              };
              window.speechSynthesis.speak(utterance);
              consumeVoiceReply();
              return;
            }
          }

          toast({
            description: "Voice output unavailable — continuing muted.",
            variant: "destructive",
          });
          consumeVoiceReply();
          backToListening();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [voiceReply, consumeVoiceReply, backToListening, toast]);

  // ── liveness: "thinking" must never trap the overlay ──
  // When the send settled without a speakable reply (error card, duel
  // pick, empty answer) the orb returns to listening.
  useEffect(() => {
    if (phase !== "thinking") return;
    if (!streaming && !voiceReply) {
      backToListening();
    }
  }, [phase, streaming, voiceReply, backToListening]);

  // ── the orb breathes with the room (listening only) ──
  useEffect(() => {
    if (phase !== "listening" || recorderState !== "recording") return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return; // calm orb for reduced-motion users
    }
    let raf = 0;
    const tick = () => {
      const el = orbRef.current;
      if (el) {
        el.style.transform = `scale(${1 + levelRef.current * 0.22})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, recorderState, levelRef]);

  const orbIcon =
    phase === "listening" ? (
      <Mic className="h-10 w-10 text-black/80" aria-hidden />
    ) : phase === "transcribing" ? (
      <Loader2 className="h-10 w-10 animate-spin text-black/80" aria-hidden />
    ) : phase === "thinking" ? (
      <Brain className="h-10 w-10 text-black/80" aria-hidden />
    ) : (
      <AudioWaveform className="h-10 w-10 text-black/80" aria-hidden />
    );

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col items-center justify-center bg-black/80 backdrop-blur-xl"
      role="dialog"
      aria-modal="true"
      aria-label="Senku voice conversation"
    >
      {/* close */}
      <button
        onClick={close}
        aria-label="Close voice mode"
        title="Close (Esc)"
        className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] flex h-10 w-10 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
      >
        <X className="h-5 w-5" />
      </button>

      {/* mute toggle */}
      <button
        onClick={() => setMuted((m) => !m)}
        aria-pressed={muted}
        aria-label={muted ? "Unmute spoken replies" : "Mute spoken replies"}
        title={muted ? "Replies stay silent" : "Replies are spoken aloud"}
        className="absolute left-4 top-[max(1rem,env(safe-area-inset-top))] flex h-10 w-10 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
      >
        {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
      </button>

      {/* brand lockup */}
      <div className="mb-10 text-center">
        <p className="text-[13px] font-semibold uppercase tracking-[0.42em] text-amber-200/90">
          Senku
        </p>
        <p className="mt-1 text-[10px] font-medium uppercase tracking-[0.3em] text-zinc-500">
          Voice Core
        </p>
      </div>

      {/* the orb */}
      <button
        onClick={() => void onOrbClick()}
        aria-label={
          phase === "listening"
            ? "Start sending — stop listening and send the message"
            : phase === "speaking" || phase === "thinking"
              ? "Interrupt"
              : "Working"
        }
        className="relative flex h-48 w-48 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70 sm:h-56 sm:w-56"
      >
        {/* halo rings */}
        <span
          aria-hidden
          className={`absolute inset-0 rounded-full border border-amber-300/25 ${
            phase === "speaking" || phase === "thinking" ? "animate-ping" : ""
          }`}
        />
        <span
          aria-hidden
          className="absolute inset-4 rounded-full border border-amber-300/15"
        />
        <div
          ref={orbRef}
          className={`flex h-40 w-40 items-center justify-center rounded-full bg-gradient-to-br from-amber-200 via-amber-400 to-orange-500 shadow-[0_0_70px_rgba(251,191,36,0.45)] transition-transform duration-100 sm:h-44 sm:w-44 ${
            phase === "thinking" ? "animate-pulse" : ""
          }`}
        >
          {orbIcon}
        </div>
      </button>

      {/* caption */}
      <p
        className="mt-10 max-w-[80vw] text-center text-[15px] font-medium text-zinc-200"
        aria-live="polite"
      >
        {CAPTIONS[phase]}
      </p>
      {lastHeard && phase !== "transcribing" && (
        <p className="mt-2 max-w-[70vw] truncate text-center text-[12.5px] text-zinc-500">
          “{lastHeard}”
        </p>
      )}
    </div>
  );
}
