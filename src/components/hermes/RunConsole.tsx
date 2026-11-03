"use client";

// Hermes — THE SANDBOX ALIVE (Run 36): the shared JavaScript run
// console. `useJsRunner` owns the sandbox lifecycle (hidden
// allow-scripts iframe, message protocol, 5 s reap); `RunConsole`
// renders the forge-styled output panel. Used by the chat code
// blocks (inline Run) and the Canvas JavaScript preview.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CircleStop, Play, RotateCcw, Trash2 } from "lucide-react";
import {
  buildRunnerDoc,
  formatElapsed,
  isSandboxMessage,
  RUNNER_TIMEOUT_MS,
  type RunLevel,
  type RunLine,
  type RunStatus,
} from "@/lib/hermes/js-runner";

const LEVEL_STYLE: Record<RunLevel, { mark: string; cls: string }> = {
  log: { mark: "›", cls: "text-zinc-200" },
  info: { mark: "ℹ", cls: "text-emerald-300/90" },
  warn: { mark: "▲", cls: "text-amber-300/90" },
  error: { mark: "✕", cls: "text-rose-400" },
  system: { mark: "·", cls: "text-amber-200/45 italic" },
};

export function useJsRunner(code: string) {
  const [lines, setLines] = useState<RunLine[]>([]);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  // Non-null while a sandbox is mounted; the object identity is the
  // iframe's React key, so every run remounts a FRESH document.
  const [frame, setFrame] = useState<{ doc: string; seq: number } | null>(null);
  const [hasRun, setHasRun] = useState(false);
  // The snapshot the current results belong to — used to DERIVE
  // staleness at render time (never reset via effects).
  const [ranCode, setRanCode] = useState<string | null>(null);
  const stale = hasRun && ranCode !== null && ranCode !== code;

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const seqRef = useRef(0);
  const reapRef = useRef<number | null>(null);
  const finishedRef = useRef(false);
  const lateRef = useRef(false);

  const push = useCallback((line: RunLine) => {
    setLines((prev) => {
      // The console is a bounded memory surface — the newest lines
      // win, the oldest fall off (an infinite logger cannot OOM us).
      const next = prev.length >= 400 ? prev.slice(prev.length - 300) : prev;
      return [...next, line];
    });
  }, []);

  const teardown = useCallback(() => {
    if (reapRef.current !== null) {
      window.clearTimeout(reapRef.current);
      reapRef.current = null;
    }
    frameRef.current = null;
    setFrame(null);
  }, []);

  const run = useCallback(() => {
    teardown();
    finishedRef.current = false;
    lateRef.current = false;
    setHasRun(true);
    setRanCode(code);
    setLines([
      {
        level: "system",
        text: "sandbox · javascript · opaque origin · no network · 5 s cap",
      },
    ]);
    setStatus("running");
    setElapsedMs(null);
    const seq = ++seqRef.current;
    setFrame({ doc: buildRunnerDoc(code), seq });
    reapRef.current = window.setTimeout(() => {
      reapRef.current = null;
      if (finishedRef.current) {
        if (lateRef.current) {
          push({
            level: "system",
            text: "sandbox closed after 5 s — long-running timers end here",
          });
        }
      } else {
        push({
          level: "system",
          text: `stopped after ${RUNNER_TIMEOUT_MS / 1000} s — infinite loop or hung program`,
        });
        setStatus("timeout");
      }
      teardown();
    }, RUNNER_TIMEOUT_MS);
  }, [code, push, teardown]);

  /** Manual stop: reap early, keep whatever already streamed. */
  const stop = useCallback(() => {
    if (status !== "running") return;
    push({ level: "system", text: "stopped by user" });
    setStatus("timeout");
    teardown();
  }, [push, status, teardown]);

  const clear = useCallback(() => {
    setLines([]);
    setStatus("idle");
    setElapsedMs(null);
    setHasRun(false);
    setRanCode(null);
    teardown();
  }, [teardown]);

  // The parent side of the message contract: only accept messages
  // from OUR sandbox's contentWindow, tagged with the protocol key.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (!win || e.source !== win || !isSandboxMessage(e.data)) return;
      const d = e.data;
      if (d.kind === "log") {
        if (finishedRef.current) lateRef.current = true;
        push({ level: d.level, text: d.text });
      } else if (d.kind === "clear") {
        setLines([]);
      } else if (d.kind === "error") {
        if (finishedRef.current) {
          lateRef.current = true;
        } else {
          finishedRef.current = true;
          setStatus("error");
          setElapsedMs(d.elapsedMs ?? null);
        }
        push({ level: "error", text: d.text });
      } else if (d.kind === "done") {
        if (finishedRef.current) return;
        finishedRef.current = true;
        setStatus("ok");
        setElapsedMs(d.elapsedMs);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [push]);

  // Final unmount cleanup.
  useEffect(() => teardown, [teardown]);

  /** Hidden sandbox iframe — render wherever, it is 0×0. */
  const sandbox: ReactNode = frame ? (
    <iframe
      key={frame.seq}
      ref={frameRef}
      title="Hermes JavaScript sandbox"
      sandbox="allow-scripts"
      srcDoc={frame.doc}
      aria-hidden
      className="absolute h-0 w-0 border-0"
    />
  ) : null;

  return {
    lines,
    status,
    elapsedMs,
    hasRun,
    /** True when the results on screen belong to an older snapshot
     *  of the code (streaming grew the block, Canvas switched
     *  blocks) — surfaced as an honest system line. */
    stale,
    run,
    stop,
    clear,
    sandbox,
  };
}

export interface JsRunner {
  lines: RunLine[];
  status: RunStatus;
  elapsedMs: number | null;
  hasRun: boolean;
  stale: boolean;
  run: () => void;
  stop: () => void;
  clear: () => void;
  sandbox: ReactNode;
}

/** The forge-styled output console. `variant="inline"` fits inside
 *  a code block (no border of its own); `variant="panel"` is the
 *  standalone Canvas surface. */
export function RunConsole({
  runner,
  variant = "inline",
  showIntro = false,
}: {
  runner: JsRunner;
  variant?: "inline" | "panel";
  showIntro?: boolean;
}) {
  const { lines, status, elapsedMs, hasRun, stale, run, stop, clear } = runner;
  const bodyRef = useRef<HTMLDivElement>(null);

  // Newest output in view: scroll to the bottom on every append.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, status]);

  const shownLines: RunLine[] = stale
    ? [
        ...lines,
        {
          level: "system",
          text: "code changed since this run — press Rerun for fresh output",
        },
      ]
    : lines;

  const running = status === "running";
  const statusChip =
    status === "running" ? (
      <span className="flex items-center gap-1.5 text-amber-300">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
        running…
      </span>
    ) : status === "ok" ? (
      <span className="text-emerald-400">
        ok{elapsedMs !== null ? ` · ${formatElapsed(elapsedMs)}` : ""}
      </span>
    ) : status === "error" ? (
      <span className="text-rose-400">
        error{elapsedMs !== null ? ` · ${formatElapsed(elapsedMs)}` : ""}
      </span>
    ) : status === "timeout" ? (
      <span className="text-rose-400">timeout</span>
    ) : (
      <span className="text-zinc-500">idle</span>
    );

  return (
    <div
      className={
        variant === "inline"
          ? "border-t border-[#332a1a] bg-[#12100b]"
          : "flex min-h-0 flex-1 flex-col rounded-xl border border-[#332a1a] bg-[#12100b]"
      }
    >
      {/* console header: run/rerun · status · clear */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[#2b2314] px-2.5">
        {running ? (
          <button
            onClick={stop}
            aria-label="Stop execution"
            title="Stop execution"
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-rose-300 transition-colors hover:bg-white/5 hover:text-rose-200"
          >
            <CircleStop className="h-3.5 w-3.5" aria-hidden />
            Stop
          </button>
        ) : (
          <button
            onClick={run}
            aria-label={hasRun ? "Run again" : "Run this JavaScript"}
            title={hasRun ? "Run again" : "Run this JavaScript in the sandbox"}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-400/10 hover:text-amber-200"
          >
            {hasRun ? (
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden />
            )}
            {hasRun ? "Rerun" : "Run"}
          </button>
        )}
        <span className="ml-auto text-[10.5px] font-semibold tabular-nums">
          {statusChip}
        </span>
        {hasRun && (
          <button
            onClick={clear}
            aria-label="Clear output"
            title="Clear output"
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">Clear</span>
          </button>
        )}
      </div>

      {showIntro && (
        <p className="shrink-0 px-3 pt-2.5 text-[11.5px] leading-relaxed text-zinc-500">
          Hermes executes this block in a sandboxed iframe — opaque origin,
          no network, hard 5 s cap. <span className="text-zinc-400">console.log</span>{" "}
          streams here; <span className="text-zinc-400">alert</span> becomes a
          log line.
        </p>
      )}

      {/* console body */}
      <div
        ref={bodyRef}
        className={`hermes-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-[1.7] ${
          variant === "panel" ? "min-h-[120px]" : "max-h-64"
        }`}
      >
        {shownLines.length === 0 ? (
          <p className="font-sans text-[11.5px] text-zinc-600">
            {hasRun
              ? "No output yet — the program may still be settling."
              : "Press Run to execute. Everything the code prints lands here."}
          </p>
        ) : (
          shownLines.map((line, i) => {
            const s = LEVEL_STYLE[line.level];
            return (
              <div key={i} className="flex gap-2 whitespace-pre-wrap break-words">
                <span aria-hidden className={`shrink-0 select-none ${s.cls}`}>
                  {s.mark}
                </span>
                <span className={`min-w-0 flex-1 ${s.cls}`}>{line.text}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
