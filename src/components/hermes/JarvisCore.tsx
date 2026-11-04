"use client";

// Senku Jarvis Core — Autonomous Hands-Free English Voice Agent Interface.
// Orchestrates continuous English speech recognition, active silence detection,
// ReAct tool execution (Exocore), Jev ensemble decision arbitration, and instant spoken synthesis.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  X,
  Sparkles,
  Cpu,
  Brain,
  Globe,
  Calculator,
  Terminal,
  Activity,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { useHermes } from "@/lib/store";

export type JarvisState = "idle" | "listening" | "thinking" | "speaking" | "error";

function formatForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "Code block omitted.")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~#]/g, "")
    .replace(/>+/g, "")
    .replace(/[-*+]\s+/g, "")
    .replace(/\[(confirmed|partial|stale sources)\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface JarvisCoreProps {
  onClose?: () => void;
}

export function JarvisCore({ onClose }: JarvisCoreProps) {
  const jarvisMode = useHermes((s) => s.jarvisMode);
  const setJarvisMode = useHermes((s) => s.setJarvisMode);

  const [state, setState] = useState<JarvisState>("idle");
  const [transcript, setTranscript] = useState("");
  const [response, setResponse] = useState("");
  const [statusDetail, setStatusDetail] = useState("Listening for English commands…");
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(true);

  const recognitionRef = useRef<any>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentTranscriptRef = useRef("");
  const abortControllerRef = useRef<AbortController | null>(null);
  const isSpeakingRef = useRef(false);

  // Stop current audio output immediately
  const cancelSpeech = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      isSpeakingRef.current = false;
    }
  }, []);

  // Speak response aloud via SpeechSynthesis
  const speakAloud = useCallback(
    (text: string, onEnd?: () => void) => {
      if (muted || typeof window === "undefined" || !("speechSynthesis" in window)) {
        onEnd?.();
        return;
      }

      cancelSpeech();
      const clean = formatForSpeech(text);
      if (!clean) {
        onEnd?.();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.lang = "en-US";
      utterance.rate = 1.05;
      utterance.pitch = 1.0;

      // Select natural English voice if available
      const voices = window.speechSynthesis.getVoices();
      const naturalVoice = voices.find(
        (v) => v.lang.startsWith("en") && (v.name.includes("Natural") || v.name.includes("Google") || v.name.includes("Samantha"))
      ) || voices.find((v) => v.lang.startsWith("en"));
      if (naturalVoice) utterance.voice = naturalVoice;

      isSpeakingRef.current = true;
      setState("speaking");

      utterance.onend = () => {
        isSpeakingRef.current = false;
        setState("idle");
        onEnd?.();
      };

      utterance.onerror = () => {
        isSpeakingRef.current = false;
        setState("idle");
        onEnd?.();
      };

      window.speechSynthesis.speak(utterance);
    },
    [cancelSpeech, muted]
  );

  // Execute recognized spoken command
  const executeSpokenCommand = useCallback(
    async (command: string) => {
      if (!command.trim()) return;

      cancelSpeech();
      setState("thinking");
      setStatusDetail("Analyzing directive…");
      setActiveTool(null);

      abortControllerRef.current?.abort();
      const ac = new AbortController();
      abortControllerRef.current = ac;

      try {
        const res = await fetch("/api/voice/jarvis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: command }),
          signal: ac.signal,
        });

        if (!res.ok) {
          throw new Error("Jarvis service returned non-200");
        }

        const result = (await res.json()) as {
          spokenText: string;
          markdownText: string;
          toolUsed?: string;
          actionSummary?: string;
          durationMs: number;
        };

        setResponse(result.markdownText);
        if (result.toolUsed) setActiveTool(result.toolUsed);
        setStatusDetail(result.actionSummary || `Completed in ${result.durationMs}ms`);

        // Speak synthesis aloud
        speakAloud(result.spokenText, () => {
          setStatusDetail("Ready for next command");
        });
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          const errMsg = "Encountered an issue executing that command.";
          setResponse(errMsg);
          setStatusDetail("Error processing directive");
          speakAloud(errMsg);
        }
      }
    },
    [cancelSpeech, speakAloud]
  );

  // Initialize SpeechRecognition continuous listener
  const startListening = useCallback(() => {
    if (typeof window === "undefined") return;

    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec) {
      setStatusDetail("Web Speech API not supported in this browser.");
      return;
    }

    try {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }

      const rec = new SpeechRec();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = "en-US";

      rec.onresult = (e: any) => {
        // If user speaks while Jarvis is speaking, interrupt audio immediately
        if (isSpeakingRef.current) {
          cancelSpeech();
        }

        let liveText = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          liveText += e.results[i][0].transcript;
        }

        const trimmed = liveText.trim();
        if (trimmed) {
          setState("listening");
          setTranscript(trimmed);
          currentTranscriptRef.current = trimmed;

          // Silence detection: user stops talking for 1200ms -> execute
          if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = setTimeout(() => {
            const captured = currentTranscriptRef.current;
            currentTranscriptRef.current = "";
            if (captured) {
              void executeSpokenCommand(captured);
            }
          }, 1200);
        }
      };

      rec.onerror = (e: { error?: string }) => {
        if (e.error !== "no-speech") {
          console.warn("[Jarvis Voice] Recognition error:", e.error);
        }
      };

      rec.onend = () => {
        // Automatically keep listening if Jarvis mode is active
        if (jarvisMode) {
          try {
            rec.start();
          } catch {
            // ignore
          }
        }
      };

      recognitionRef.current = rec;
      rec.start();
      setState("idle");
      setStatusDetail("Jarvis active — listening for English directives…");
    } catch (err) {
      console.warn("[Jarvis Voice] Failed to start:", err);
    }
  }, [cancelSpeech, executeSpokenCommand, jarvisMode]);

  // Lifecycle
  useEffect(() => {
    if (jarvisMode) {
      startListening();
    } else {
      cancelSpeech();
      if (recognitionRef.current) {
        recognitionRef.current.abort();
        recognitionRef.current = null;
      }
    }

    return () => {
      cancelSpeech();
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }
    };
  }, [cancelSpeech, jarvisMode, startListening]);

  // Keyboard shortcut ESC to exit
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setJarvisMode(false);
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, setJarvisMode]);

  if (!jarvisMode) return null;

  return (
    <div
      role="dialog"
      aria-label="Senku Jarvis Voice Assistant"
      className={`fixed z-50 transition-all duration-300 ${
        fullscreen
          ? "inset-0 flex flex-col items-center justify-between bg-black/90 p-6 backdrop-blur-xl"
          : "bottom-6 right-6 flex w-96 flex-col rounded-2xl border border-amber-500/20 bg-zinc-950/95 p-5 shadow-2xl backdrop-blur-lg"
      }`}
    >
      {/* Top Bar Controls */}
      <div className="flex w-full items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="relative flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-500" />
          </div>
          <span className="text-sm font-semibold tracking-wider text-amber-300">
            SENKU JARVIS
          </span>
          <span className="rounded bg-amber-500/10 px-2 py-0.5 text-[11px] font-mono text-amber-400/80">
            EN-US
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setMuted((m) => !m)}
            className="rounded-lg p-2 text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
            title={muted ? "Unmute speech output" : "Mute speech output"}
            aria-label="Toggle mute"
          >
            {muted ? <VolumeX className="h-4 w-4 text-rose-400" /> : <Volume2 className="h-4 w-4" />}
          </button>
          <button
            onClick={() => setFullscreen((f) => !f)}
            className="rounded-lg p-2 text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
            title={fullscreen ? "Dock Jarvis" : "Expand to fullscreen"}
            aria-label="Toggle fullscreen"
          >
            {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            onClick={() => {
              setJarvisMode(false);
              onClose?.();
            }}
            className="rounded-lg p-2 text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
            title="Exit Jarvis (Esc)"
            aria-label="Close Jarvis"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Center Interactive Medallion */}
      <div className="my-auto flex flex-col items-center justify-center gap-6 text-center">
        {/* Animated Jarvis Medallion Orb */}
        <div className="relative flex items-center justify-center">
          {/* Orbital Outer Halo */}
          <div
            className={`absolute -inset-10 rounded-full transition-all duration-700 ${
              state === "listening"
                ? "bg-amber-500/20 blur-2xl scale-125 animate-pulse"
                : state === "thinking"
                ? "bg-cyan-500/20 blur-2xl scale-110 animate-spin"
                : state === "speaking"
                ? "bg-emerald-500/20 blur-2xl scale-120 animate-pulse"
                : "bg-amber-500/5 blur-xl scale-100"
            }`}
          />

          {/* Concentric Orbital Rings */}
          <div
            className={`relative flex h-36 w-36 items-center justify-center rounded-full border border-amber-400/30 bg-black/60 shadow-[0_0_50px_rgba(245,158,11,0.2)] transition-transform duration-300 ${
              state === "listening"
                ? "scale-105 border-amber-400"
                : state === "thinking"
                ? "border-cyan-400 animate-pulse"
                : state === "speaking"
                ? "border-emerald-400"
                : "hover:scale-102"
            }`}
          >
            <div className="flex flex-col items-center justify-center gap-1">
              {state === "thinking" ? (
                <Cpu className="h-10 w-10 animate-spin text-cyan-400" />
              ) : state === "speaking" ? (
                <Activity className="h-10 w-10 animate-pulse text-emerald-400" />
              ) : (
                <Mic className="h-10 w-10 text-amber-400" />
              )}
              <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-400">
                {state}
              </span>
            </div>
          </div>
        </div>

        {/* Status text */}
        <div className="flex flex-col items-center gap-2">
          <p className="max-w-md text-sm font-medium text-zinc-300">{statusDetail}</p>

          {/* Active Tool Badge */}
          {activeTool && (
            <div className="flex items-center gap-1.5 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-xs text-cyan-300">
              {activeTool === "web_search" && <Globe className="h-3 w-3" />}
              {activeTool === "calculator" && <Calculator className="h-3 w-3" />}
              {activeTool === "jev_decide" && <Brain className="h-3 w-3" />}
              {activeTool === "system_status" && <Activity className="h-3 w-3" />}
              <span>Tool: {activeTool}</span>
            </div>
          )}
        </div>

        {/* Live Transcript and Response */}
        <div className="flex w-full max-w-xl flex-col gap-3 px-4">
          {transcript && (
            <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3 text-left">
              <span className="text-[11px] font-mono uppercase text-amber-400/80">You:</span>
              <p className="mt-0.5 text-sm text-zinc-200">{transcript}</p>
            </div>
          )}

          {response && (
            <div className="max-h-48 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.04] p-3.5 text-left">
              <span className="text-[11px] font-mono uppercase text-emerald-400/80">Jarvis:</span>
              <p className="mt-0.5 text-sm leading-relaxed text-zinc-100">{response}</p>
            </div>
          )}
        </div>
      </div>

      {/* Quick Spoken Directive Starter Chips */}
      <div className="flex flex-wrap items-center justify-center gap-2 pt-4">
        {[
          "Check system status",
          "Search latest AI releases",
          "Calculate 128 * 4.5",
          "Decide between Bun vs Node for performance",
        ].map((sample) => (
          <button
            key={sample}
            onClick={() => {
              setTranscript(sample);
              void executeSpokenCommand(sample);
            }}
            className="rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1 text-xs text-zinc-400 transition hover:border-amber-400/40 hover:bg-amber-400/10 hover:text-amber-200"
          >
            “{sample}”
          </button>
        ))}
      </div>
    </div>
  );
}
