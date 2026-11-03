"use client";

// Hermes — floating bottom input bar:
// "+" attachments menu (REAL file reading — extraction runs the
// moment a file is picked, chips show what the gateway read; on
// phones it also hosts Search / Image / Duel, keeping the deck a
// single row), Search toggle pill, effort dial, model selector chip
// (pretty name + tier badge + caret, grouped provider dropdown),
// server-backed voice messages with a live waveform — stopping the
// recording transcribes and SENDS hands-free (Run 33).

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  Brain,
  ChevronDown,
  Check,
  Code2,
  Eye,
  FileImage,
  FileText,
  FoldVertical,
  Globe,
  Image as ImageIcon,
  Loader2,
  Mic,
  Paperclip,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  Swords,
  Trash2,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import { useHermes, type PendingAttachment } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { useVoiceRecorder } from "@/hooks/use-voice-recorder";
import { effortModel, modelGlyph, modelHint, modelMeta } from "@/lib/hermes/models";
import { IMAGE_SIZES, IMAGE_SIZE_KEYS } from "@/lib/hermes/image-forge";
import { countLines } from "@/lib/hermes/format";
import type { EffortLevel } from "@/lib/hermes/types";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const WAVE_BARS = 26;
const ATTACHMENT_CAP = 5;

/** Run 17 — plain-text pastes longer than this many lines (LF/CRLF
 *  consistent) become a removable attachment pill instead of
 *  flooding the textarea. Exactly 60 lines stays inline. */
const PASTE_SNIPPET_LINES = 60;

/** The slash commands offered in the / popover. /search reflects the
 *  REAL search capability (grounded pipeline with cited sources) and
 *  shows its live on/off state — nothing here implies a capability
 *  the gateway doesn't have. */
const SLASH_COMMANDS = [
  {
    cmd: "code",
    icon: Code2,
    desc: "Code-focused answer, no chatter — next message",
  },
  {
    cmd: "concise",
    icon: FoldVertical,
    desc: "Ultra-brief answer — next message",
  },
  {
    cmd: "search",
    icon: Globe,
    desc: "Web search with cited sources",
  },
  {
    cmd: "image",
    icon: ImageIcon,
    desc: "Forge an image from your next message",
  },
  {
    cmd: "agent",
    icon: Bot,
    desc: "Agentic task — tools, web search, calculator, Jev arbitration",
  },
] as const;
type SlashCommand = (typeof SLASH_COMMANDS)[number];

/** The /-token under the caret, if any. The "/" must sit at the very
 *  start of the input or right after whitespace — typing "/" mid-word
 *  ("a/b") or inside a URL ("https://x") never triggers the popover. */
function activeSlashToken(
  value: string,
  caret: number
): { query: string; start: number } | null {
  const upto = value.slice(0, caret);
  const m = /(^|\s)\/([\w-]{0,20})$/.exec(upto);
  if (!m) return null;
  return { query: m[2].toLowerCase(), start: caret - m[2].length - 1 };
}

function formatChars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k chars`;
  return `${n} chars`;
}

function kindIcon(p: PendingAttachment) {
  return p.kindGuess === "image";
}

/** One staged file: icon + name + live extraction status. The chip
 *  tells the user exactly what the model will receive — chars read,
 *  vision pass, truncation — or why the file can't be sent. */
function AttachmentChip({
  p,
  onRemove,
  disabled,
}: {
  p: PendingAttachment;
  onRemove: () => void;
  disabled: boolean;
}) {
  const isImage = kindIcon(p);
  return (
    <div
      className={`flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left ${
        p.status === "error"
          ? "border-red-500/30 bg-red-500/5"
          : "border-zinc-700/70 bg-[#1d1d20]"
      }`}
      aria-label={
        p.status === "ready"
          ? `Attachment ${p.name}, read by the gateway`
          : `Attachment ${p.name}`
      }
    >
      {isImage ? (
        <FileImage
          className={`h-4 w-4 shrink-0 ${
            p.status === "error" ? "text-red-400/80" : "text-zinc-400"
          }`}
          aria-hidden
        />
      ) : (
        <FileText
          className={`h-4 w-4 shrink-0 ${
            p.status === "error" ? "text-red-400/80" : "text-zinc-400"
          }`}
          aria-hidden
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-zinc-200">
          {p.name}
        </span>
        {p.status === "extracting" && (
          <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            reading…
          </span>
        )}
        {p.status === "ready" && p.record && (
          <span
            className="flex items-center gap-1 text-[11px] text-emerald-300/80"
            title={
              p.record.truncated
                ? `Sent to the model: first ${formatChars(p.record.chars)} of ${p.record.totalChars} — the rest was cut to fit`
                : p.record.kind === "image"
                  ? `Sent to the model: ${p.record.chars} characters from a vision pass (OCR + description)`
                  : p.name.startsWith("Pasted snippet")
                    ? `Sent to the model: the pasted snippet, ${p.record.chars} characters`
                    : `Sent to the model: ${p.record.chars} characters read from the file`
            }
          >
            {p.record.kind === "image" ? (
              <Eye className="h-3 w-3 shrink-0" aria-hidden />
            ) : (
              <Check className="h-3 w-3 shrink-0" aria-hidden />
            )}
            {p.record.kind === "image" ? "vision pass · " : "read · "}
            {formatChars(p.record.chars)}
            {p.record.truncated ? " (truncated)" : ""}
          </span>
        )}
        {p.status === "error" && (
          <span className="flex items-start gap-1 text-[11px] leading-snug text-red-300/80">
            <TriangleAlert className="mt-px h-3 w-3 shrink-0" aria-hidden />
            {p.error} — not sent
          </span>
        )}
      </span>
      <button
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Remove ${p.name}`}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200 disabled:opacity-40"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ── Effort dial ──────────────────────────────────────────────
// How hard the gateway works on one turn. On single-brand chats a
// fast/quality toggle flips one backend's switch; here each level
// can route to a different ENGINE from the pool.
const EFFORTS: {
  level: EffortLevel;
  label: string;
  desc: string;
  icon: typeof Zap;
  pill: string;
}[] = [
  {
    level: "fast",
    label: "Fast",
    desc: "Fastest engine in the pool · brief, direct answers",
    icon: Zap,
    pill: "border-yellow-300/60 bg-yellow-300/10 text-yellow-200",
  },
  {
    level: "medium",
    label: "Medium",
    desc: "Your selected model · balanced (default)",
    icon: Sparkles,
    pill: "",
  },
  {
    level: "deep",
    label: "Deep",
    desc: "Strongest engine · thinking · deep research with Search",
    icon: Brain,
    pill: "border-emerald-300/60 bg-emerald-300/10 text-emerald-200",
  },
];

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function InputBar() {
  const {
    searchEnabled,
    toggleSearch,
    temporary,
    model,
    models,
    setModel,
    syncModels,
    streaming,
    sendMessage,
    sendImage,
    stopStreaming,
    limiter,
    duelEnabled,
    toggleDuel,
    challenger,
    setChallenger,
    effort,
    setEffort,
    imageMode,
    toggleImageMode,
    imageSize,
    setImageSize,
    pendingAttachments,
    addAttachments,
    removePendingAttachment,
    turnStyle,
    setTurnStyle,
    stagePastedSnippet,
    // Run 40 — THE EXOCORE
    agentArmed,
    armAgent,
    setVoiceMode,
  } = useHermes();
  const { toast } = useToast();

  const [value, setValue] = useState("");
  const [attachOpen, setAttachOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [challengerOpen, setChallengerOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [imageSizeOpen, setImageSizeOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  // Run 17 — slash popover: caret position drives the active /-token,
  // slashIndex is the highlighted option, and a dismissed token stays
  // dismissed (Escape) until the token itself changes.
  const [caret, setCaret] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissedKey, setSlashDismissedKey] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorder = useVoiceRecorder();
  const waveBarsRef = useRef<(HTMLDivElement | null)[]>([]);
  const waveLevelsRef = useRef<number[]>(new Array(WAVE_BARS).fill(4));
  // true while finishDictation owns the stop → transcribe → send
  // pipeline; lets the cap-rescue effect below tell a user-initiated
  // stop apart from the hook's own 60s auto-stop
  const stoppingRef = useRef(false);

  const providerName = limiter?.providerName ?? "";
  const extractingAttachments = pendingAttachments.some(
    (p) => p.status === "extracting"
  );
  const canSend =
    value.trim().length > 0 && !streaming && !extractingAttachments;
  const isRecording = recorder.state === "recording";
  const isProcessing = recorder.state === "processing" || transcribing;
  // A duel needs a second model to race against.
  const duelAvailable = models.filter((m) => m !== model).length > 0;

  // auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 208) + "px";
  }, [value]);

  // surface recorder permission/device errors
  useEffect(() => {
    if (recorder.error) {
      toast({ description: recorder.error, variant: "destructive" });
    }
  }, [recorder.error, toast]);

  // live waveform: push the smoothed mic level through a rolling window
  // and paint bar heights directly on the DOM (no re-render per frame)
  useEffect(() => {
    if (recorder.state !== "recording") return;
    let raf = 0;
    const loop = () => {
      const level = recorder.levelRef.current;
      const next = waveLevelsRef.current
        .slice(1)
        .concat(4 + level * level * 42 + Math.random() * 2);
      waveLevelsRef.current = next;
      for (let i = 0; i < WAVE_BARS; i++) {
        const el = waveBarsRef.current[i];
        if (el) el.style.height = `${Math.max(4, next[i]).toFixed(1)}px`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [recorder.state, recorder.levelRef]);

  const submit = () => {
    if (!canSend) return;
    const content = value.trim();
    setValue("");
    // Run 22 — Image mode routes the send to the forge pipeline.
    if (imageMode) {
      void sendImage(content);
    } else {
      void sendMessage(content);
    }
  };

  // stop → transcribe (server ASR) → send it, hands-free (Run 33).
  // If a reply is still streaming or an attachment is still being
  // read (the send guard would drop the message), the transcript
  // lands in the composer instead — nothing is ever lost.
  const finishDictation = async () => {
    if (stoppingRef.current) return; // already finishing (cap + click)
    stoppingRef.current = true;
    recorder.stop();
    setTranscribing(true);
    try {
      const wav = await recorder.takeResult();
      if (!wav) {
        toast({ description: "Didn't catch that — try speaking a bit louder." });
        return;
      }
      const res = await fetch("/api/voice/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: wav }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Transcription failed");
      const text = String(data.text ?? "").trim();
      if (!text) {
        toast({ description: "Didn't catch that — try speaking a bit louder." });
        return;
      }
      // anything already typed rides along with the dictation — read
      // from the DOM so text typed WHILE transcribing isn't dropped
      const typed = (textareaRef.current?.value ?? value).trim();
      const merged = typed ? `${typed} ${text}` : text;
      // fresh store state — the ASR round-trip took a few seconds
      const s = useHermes.getState();
      const blocked =
        s.streaming || s.pendingAttachments.some((p) => p.status === "extracting");
      if (blocked) {
        setValue(merged);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }
        });
        toast({ description: "Transcribed — send it when the current reply finishes." });
        return;
      }
      setValue("");
      if (s.imageMode) void s.sendImage(merged);
      else void s.sendMessage(merged);
    } catch (e) {
      toast({
        description: (e as Error).message || "Transcription failed.",
        variant: "destructive",
      });
    } finally {
      setTranscribing(false);
      stoppingRef.current = false;
    }
  };

  // Run 33 — the 60s hard cap stops the recorder inside the hook;
  // that used to strand the bar on the "Transcribing" spinner with
  // no way out. Ride the exact same pipeline as the stop button:
  // transcribe, then auto-send.
  useEffect(() => {
    if (recorder.state === "processing" && !stoppingRef.current) {
      void finishDictation();
    }
  }, [recorder.state]);

  const onMicClick = () => {
    if (recorder.state === "recording") {
      void finishDictation();
    } else if (recorder.state === "idle") {
      void recorder.start();
    }
  };

  const onUpload = () => {
    setAttachOpen(false);
    fileRef.current?.click();
  };

  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length) return;
    const room = ATTACHMENT_CAP - pendingAttachments.length;
    if (room <= 0) {
      toast({
        description: `Up to ${ATTACHMENT_CAP} files per message.`,
        variant: "destructive",
      });
      return;
    }
    const accepted = files.slice(0, room);
    if (files.length > accepted.length) {
      toast({
        description: `Only ${accepted.length} of ${files.length} files added — up to ${ATTACHMENT_CAP} per message.`,
      });
    }
    void addAttachments(accepted).then(() => {
      /* per-file results are shown on the chips */
    });
  };

  const activeMeta = modelMeta(model);

  // ── Slash popover (Run 17) ──
  const slashToken = useMemo(
    () => activeSlashToken(value, caret),
    [value, caret]
  );
  const slashMatches = useMemo(() => {
    if (!slashToken) return [] as readonly SlashCommand[];
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(slashToken.query));
  }, [slashToken]);
  const slashKey =
    slashToken != null ? `${slashToken.start}:${slashToken.query}` : null;
  const slashOpen =
    slashToken != null &&
    slashMatches.length > 0 &&
    slashDismissedKey !== slashKey;
  const slashActive =
    slashMatches.length > 0
      ? slashMatches[Math.min(slashIndex, slashMatches.length - 1)]
      : null;

  const dismissSlash = () => {
    if (slashKey) setSlashDismissedKey(slashKey);
  };

  /** Apply one slash command: strip the /token from the draft (it is
   *  NEVER sent as prompt text), then update the real mode state. */
  const applySlash = (c: SlashCommand) => {
    if (!slashToken) return;
    const before = value.slice(0, slashToken.start);
    const after = value.slice(caret);
    const next = (before + after).replace(/\s+$/, "");
    setValue(next);
    dismissSlash();
    if (c.cmd === "code") {
      setTurnStyle("code");
      toast({
        description: "Code mode — your next message gets a code-focused answer.",
      });
    } else if (c.cmd === "concise") {
      setTurnStyle("concise");
      toast({
        description: "Concise mode — your next message gets an ultra-brief answer.",
      });
    } else if (c.cmd === "search") {
      if (!searchEnabled) toggleSearch();
      toast({ description: "Web search on — answers will cite sources." });
    } else if (c.cmd === "image") {
      if (!imageMode) toggleImageMode();
      toast({
        description:
          "Image mode on — your next message becomes a generated image (30–90s).",
      });
    } else if (c.cmd === "agent") {
      armAgent();
      toast({
        description:
          "Agent mode armed — your next message runs through the tool loop (web search, calculator, gateway status, Jev).",
      });
    }
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        const pos = next.length;
        el.setSelectionRange(pos, pos);
        setCaret(pos);
      }
    });
  };

  /** >60-line plain-text pastes become a removable attachment pill —
   *  the exact text is preserved and only leaves with the next send.
   *  File pastes and short pastes keep the browser default. */
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (items && Array.from(items).some((it) => it.kind === "file")) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    const lines = countLines(text);
    if (lines <= PASTE_SNIPPET_LINES) return; // exactly 60 stays inline
    e.preventDefault();
    const res = stagePastedSnippet(text);
    if (!res.ok) {
      toast({ description: res.error, variant: "destructive" });
      return;
    }
    toast({
      description: `Pasted snippet (${lines} lines) attached — it will be sent with your next message.`,
    });
  };

  return (
    // hermes-input-in — one gentle settle on load (Run 18): the bar
    // already sits in its final position from the first paint (the
    // view slot above is always rendered), so this is a purely
    // cosmetic 8px rise + fade, never a position jump.
    <div className="hermes-input-in relative mx-auto w-full max-w-3xl shrink-0 px-4">
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={onFilePicked}
        aria-hidden
      />

      {/* Run 17 — armed one-shot style pill (/code, /concise).
          Removable; consumed by the next send. */}
      {turnStyle && (
        <div className="mb-2 flex items-center gap-2 pl-1.5">
          <div
            className="flex items-center gap-1.5 rounded-full border border-amber-300/40 bg-amber-300/10 py-1 pl-2.5 pr-1 text-[12px] text-amber-200"
            aria-live="polite"
          >
            {turnStyle === "code" ? (
              <Code2 className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <FoldVertical className="h-3.5 w-3.5" aria-hidden />
            )}
            {turnStyle === "code" ? "Code mode" : "Concise mode"}
            <span className="text-amber-200/55">· next message</span>
            <button
              type="button"
              onClick={() => setTurnStyle(null)}
              aria-label={`Disable ${turnStyle} mode`}
              className="flex h-5 w-5 items-center justify-center rounded-full text-amber-200/70 transition-colors hover:bg-white/10 hover:text-amber-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}

      {/* Run 40 — armed agent pill (/agent). Removable; consumed by
          the next send, which routes through the agentic loop. */}
      {agentArmed && (
        <div className="mb-2 flex items-center gap-2 pl-1.5">
          <div
            className="flex items-center gap-1.5 rounded-full border border-amber-300/40 bg-amber-300/10 py-1 pl-2.5 pr-1 text-[12px] text-amber-200"
            aria-live="polite"
          >
            <Bot className="h-3.5 w-3.5" aria-hidden />
            Agent mode
            <span className="text-amber-200/55">· next message runs tools</span>
            <button
              type="button"
              onClick={() => useHermes.setState({ agentArmed: false })}
              aria-label="Disable agent mode"
              className="flex h-5 w-5 items-center justify-center rounded-full text-amber-200/70 transition-colors hover:bg-white/10 hover:text-amber-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}

      <div className="relative rounded-[26px] border border-zinc-700/70 bg-[#262627] shadow-[0_8px_32px_rgba(0,0,0,0.45)] transition-colors focus-within:border-zinc-500">
        {/* Slash-command popover (Run 17) — anchored above the text
            area while a /-token is under the caret. */}
        {slashOpen && slashActive && (
          <div
            id="hermes-slash-menu"
            role="listbox"
            aria-label="Slash commands"
            className="absolute bottom-full left-2 z-20 mb-2 w-72 overflow-hidden rounded-xl border border-zinc-700/70 bg-[#212121] p-1 shadow-2xl"
          >
            {slashMatches.map((c, i) => {
              const active = c.cmd === slashActive.cmd;
              const Icon = c.icon;
              return (
                <button
                  key={c.cmd}
                  id={`hermes-slash-opt-${c.cmd}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep the textarea focused
                    applySlash(c);
                  }}
                  onMouseEnter={() => setSlashIndex(i)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    active ? "bg-white/5" : ""
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-zinc-100">
                      /{c.cmd}
                    </span>
                    <span className="block truncate text-[11px] text-zinc-500">
                      {c.desc}
                    </span>
                  </span>
                  {c.cmd === "search" && (
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                        searchEnabled
                          ? "bg-emerald-400/15 text-emerald-300"
                          : "bg-zinc-700/60 text-zinc-400"
                      }`}
                    >
                      {searchEnabled ? "On" : "Off"}
                    </span>
                  )}
                  {c.cmd === "image" && (
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                        imageMode
                          ? "bg-amber-300/15 text-amber-200"
                          : "bg-zinc-700/60 text-zinc-400"
                      }`}
                    >
                      {imageMode ? "On" : "Off"}
                    </span>
                  )}
                </button>
              );
            })}
            <p className="px-2.5 pb-1 pt-1.5 text-[10px] text-zinc-600">
              ↑↓ navigate · Enter apply · Esc dismiss
            </p>
          </div>
        )}
        {isRecording ? (
          /* live waveform strip replaces the textarea while dictating */
          <div className="hermes-rec-in flex h-[52px] items-center gap-3 px-4" aria-live="polite">
            <span className="flex shrink-0 items-center gap-2 tabular-nums text-[13px] text-red-400">
              <span className="hermes-rec-dot inline-block h-2 w-2 rounded-full bg-red-400" />
              {formatElapsed(recorder.elapsedMs)}
            </span>
            <div className="flex h-10 min-w-0 flex-1 items-center justify-center gap-[3px]" aria-hidden>
              {Array.from({ length: WAVE_BARS }).map((_, i) => (
                <div
                  key={i}
                  ref={(el) => {
                    waveBarsRef.current[i] = el;
                  }}
                  className="hermes-wave-bar"
                  style={{ height: 4 }}
                />
              ))}
            </div>
            <span className="hidden shrink-0 text-[11px] text-zinc-500 sm:block">
              tap ◼ to stop
            </span>
          </div>
        ) : isProcessing ? (
          <div className="flex h-[52px] items-center px-4" aria-live="polite">
            <span className="hermes-thinking-label text-[14px] font-medium">
              Transcribing…
            </span>
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setCaret(e.target.selectionStart ?? 0);
            }}
            onSelect={(e) =>
              setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)
            }
            onPaste={onPaste}
            onKeyDown={(e) => {
              // IME composition (CJK input…): the Enter that confirms
              // a composition must never submit or drive the popover.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;

              if (slashOpen) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashIndex(
                    (i) => (i + 1) % Math.max(slashMatches.length, 1)
                  );
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashIndex(
                    (i) =>
                      (i - 1 + Math.max(slashMatches.length, 1)) %
                      Math.max(slashMatches.length, 1)
                  );
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  if (slashActive) applySlash(slashActive);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  dismissSlash();
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder={
              imageMode
                ? "Describe the image to forge… (/ for commands)"
                : "Message Hermes... (/ for commands)"
            }
            aria-label="Message Hermes"
            aria-controls={slashOpen ? "hermes-slash-menu" : undefined}
            aria-activedescendant={
              slashOpen && slashActive
                ? `hermes-slash-opt-${slashActive.cmd}`
                : undefined
            }
            aria-autocomplete="list"
            className="hermes-scroll max-h-52 w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[15px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-500"
          />
        )}

        {/* staged attachments — one chip per file, live extraction
            status: what the gateway read is what the model gets */}
        {pendingAttachments.length > 0 && (
          <div className="hermes-scroll max-h-44 space-y-1.5 overflow-y-auto px-3 pt-2">
            {pendingAttachments.map((p) => (
              <AttachmentChip
                key={p.id}
                p={p}
                disabled={streaming}
                onRemove={() => removePendingAttachment(p.id)}
              />
            ))}
          </div>
        )}

        {/* Run 25.1 — the deck, ONE row on every screen. On phones
            Search / Image / Duel are hidden: they live in the "+"
            menu (which already carries them with live On/Off chips),
            so the composer stays a single calm line — + · effort ·
            model · mic · send. Armed modes still surface contextually
            (dimensions chip, challenger chip, + dot). ≥640px keeps
            the full labeled strip, byte-identical. */}
        <div className="flex items-center justify-between gap-1.5 px-2.5 pb-2.5 pt-0.5">
          {/* left controls — + and effort (plus contextual armed
              chips); ≥640px also shows the Search / Image / Duel
              strip, scrollable so labels + challenger never wrap */}
          <div className="hermes-scroll flex min-w-0 items-center gap-1 overflow-x-auto sm:gap-1.5">
            <Popover open={attachOpen} onOpenChange={setAttachOpen}>
              <PopoverTrigger asChild>
                <button
                  aria-label="Add attachments"
                  title="Files · Search · Image · Duel"
                  className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-200"
                >
                  <Plus className="h-[18px] w-[18px]" />
                  {(searchEnabled || imageMode || duelEnabled) && (
                    <span
                      aria-hidden
                      className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-400"
                    />
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="start"
                className="w-64 rounded-xl border-zinc-800 bg-[#262627] p-1.5 text-zinc-200 shadow-2xl"
              >
                <button
                  onClick={onUpload}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] hover:bg-white/5"
                >
                  <Paperclip className="h-4 w-4 text-zinc-400" />
                  <span className="flex min-w-0 flex-col">
                    <span>Upload from computer</span>
                    <span className="truncate text-[10.5px] text-zinc-500">
                      Text · code · PDF · image — read before sending
                    </span>
                  </span>
                </button>
                <button
                  onClick={() => {
                    toggleSearch();
                    setAttachOpen(false);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] hover:bg-white/5"
                >
                  <Globe className="h-4 w-4 text-zinc-400" />
                  Search the web
                  <span
                    className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                      searchEnabled
                        ? "bg-emerald-400/15 text-emerald-300"
                        : "bg-zinc-700/60 text-zinc-400"
                    }`}
                  >
                    {searchEnabled ? "On" : "Off"}
                  </span>
                </button>
                <button
                  onClick={() => {
                    if (!imageMode) {
                      toast({
                        description:
                          "Image mode — your next message becomes a generated image (30–90s).",
                      });
                    }
                    toggleImageMode();
                    setAttachOpen(false);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] hover:bg-white/5"
                >
                  <ImageIcon className="h-4 w-4 text-zinc-400" />
                  Generate an image
                  <span
                    className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                      imageMode
                        ? "bg-amber-300/15 text-amber-200"
                        : "bg-zinc-700/60 text-zinc-400"
                    }`}
                  >
                    {imageMode ? "On" : "Off"}
                  </span>
                </button>
                {duelAvailable && (
                  <button
                    onClick={() => {
                      if (!duelEnabled) {
                        toast({
                          description:
                            "Duel armed — next message races two models; you pick the keeper.",
                        });
                      }
                      toggleDuel();
                      setAttachOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] hover:bg-white/5"
                  >
                    <Swords className="h-4 w-4 text-zinc-400" />
                    Duel two models
                    <span
                      className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                        duelEnabled
                          ? "bg-emerald-400/15 text-emerald-300"
                          : "bg-zinc-700/60 text-zinc-400"
                      }`}
                    >
                      {duelEnabled ? "On" : "Off"}
                    </span>
                  </button>
                )}
              </PopoverContent>
            </Popover>

            <button
              onClick={toggleSearch}
              aria-pressed={searchEnabled}
              className={`hidden h-9 w-9 shrink-0 items-center justify-center gap-1.5 rounded-full border text-[13px] transition-colors sm:flex sm:h-8 sm:w-auto sm:px-2.5 ${
                searchEnabled
                  ? "border-zinc-400 bg-white/10 text-white"
                  : "border-zinc-600 text-zinc-300 hover:bg-white/5"
              }`}
              title="Toggle web search — grounded answers with cited sources (max 3 snippets, 300 chars each)"
            >
              <Globe className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Search</span>
            </button>

            {/* Run 22 — Image Forge toggle. Arms the forge pipeline for
                the next send; Search and Duel disarm automatically
                (different pipelines, never ambiguous). */}
            <button
              onClick={() => {
                if (!imageMode) {
                  toast({
                    description:
                      "Image mode — your next message becomes a generated image (30–90s).",
                  });
                }
                toggleImageMode();
              }}
              aria-pressed={imageMode}
              className={`hidden h-9 w-9 shrink-0 items-center justify-center gap-1.5 rounded-full border text-[13px] transition-colors sm:flex sm:h-8 sm:w-auto sm:px-2.5 ${
                imageMode
                  ? "border-amber-300/70 bg-amber-300/10 text-amber-200"
                  : "border-zinc-600 text-zinc-300 hover:bg-white/5"
              }`}
              title="Image Forge — turn your next message into a generated image (runs on the Z.ai image engine, never spends pool tokens)"
            >
              <ImageIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Image</span>
            </button>

            {/* Forge dimensions — shown while Image mode is armed */}
            {imageMode && (
              <Popover open={imageSizeOpen} onOpenChange={setImageSizeOpen}>
                <PopoverTrigger asChild>
                  <button
                    aria-label="Pick image dimensions"
                    title={`Dimensions — currently ${IMAGE_SIZES[imageSize].label} (${IMAGE_SIZES[imageSize].dims})`}
                    className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800/40 px-2 text-[12px] text-zinc-300 transition-colors hover:bg-white/5 sm:max-w-[150px] sm:px-2.5"
                  >
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-300/80">
                      at
                    </span>
                    <span className="hidden truncate font-medium sm:inline">
                      {IMAGE_SIZES[imageSize].label}
                    </span>
                    <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="start"
                  className="w-64 rounded-xl border-zinc-800 bg-[#212121] p-0 shadow-2xl"
                >
                  <div className="border-b border-zinc-800 px-3.5 py-2.5">
                    <span className="text-[11px] font-semibold tracking-[0.12em] text-zinc-400">
                      IMAGE DIMENSIONS
                    </span>
                  </div>
                  <div className="py-1">
                    {IMAGE_SIZE_KEYS.map((k) => {
                      const s = IMAGE_SIZES[k];
                      const active = k === imageSize;
                      return (
                        <button
                          key={k}
                          onClick={() => {
                            setImageSize(k);
                            setImageSizeOpen(false);
                          }}
                          className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-white/5 ${
                            active ? "text-white" : "text-zinc-300"
                          }`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-medium">
                              {s.label}
                            </span>
                            <span className="block truncate text-[11px] text-zinc-500">
                              {s.dims} · {s.hint}
                            </span>
                          </span>
                          {active && (
                            <Check className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>
            )}

            {/* Effort dial — fast / medium / deep. Each level can
                route to a different pooled engine; the popover shows
                exactly which engine serves each level. */}
            <Popover open={effortOpen} onOpenChange={setEffortOpen}>
              <PopoverTrigger asChild>
                <button
                  aria-label={`Effort level: ${effort}. Change how hard the gateway works`}
                  aria-expanded={effortOpen}
                  className={`flex h-9 w-9 shrink-0 items-center justify-center gap-1.5 rounded-full border text-[13px] transition-colors sm:h-8 sm:w-auto sm:px-2.5 ${
                    effort === "medium"
                      ? "border-zinc-600 text-zinc-300 hover:bg-white/5"
                      : EFFORTS.find((e) => e.level === effort)?.pill ?? ""
                  }`}
                  title="Effort — Fast: fastest engine, brief · Medium: your model · Deep: strongest engine, thinking + deep research"
                >
                  {(() => {
                    const E = EFFORTS.find((e) => e.level === effort) ?? EFFORTS[1];
                    return <E.icon className="h-3.5 w-3.5" />;
                  })()}
                  <span className="hidden sm:inline">
                    {EFFORTS.find((e) => e.level === effort)?.label ?? "Medium"}
                  </span>
                  <ChevronDown className="hidden h-3 w-3 shrink-0 text-zinc-500 sm:block" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="start"
                className="w-80 rounded-xl border-zinc-800 bg-[#212121] p-0 shadow-2xl"
              >
                <div className="border-b border-zinc-800 px-3.5 py-2.5">
                  <span className="text-[11px] font-semibold tracking-[0.12em] text-zinc-400">
                    EFFORT — HOW HARD THIS TURN WORKS
                  </span>
                </div>
                <div className="py-1">
                  {EFFORTS.map(({ level, label, desc, icon: Icon }) => {
                    const routed = effortModel(models, model, level);
                    const routedMeta = modelMeta(routed);
                    return (
                      <button
                        key={level}
                        onClick={() => {
                          setEffort(level);
                          setEffortOpen(false);
                        }}
                        className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-white/5 ${
                          level === effort ? "text-white" : "text-zinc-300"
                        }`}
                      >
                        <Icon
                          className={`h-4 w-4 shrink-0 ${
                            level === effort
                              ? level === "fast"
                                ? "text-yellow-300"
                                : level === "deep"
                                  ? "text-emerald-300"
                                  : "text-zinc-200"
                              : "text-zinc-500"
                          }`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-medium">{label}</span>
                          <span className="block truncate text-[11px] text-zinc-500">
                            {desc}
                          </span>
                        </span>
                        <span
                          className="max-w-[96px] shrink-0 truncate text-[11px] text-zinc-400"
                          title={routed}
                        >
                          {routed === model ? routedMeta.name : `→ ${routedMeta.name}`}
                        </span>
                        {level === effort && (
                          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                        )}
                      </button>
                    );
                  })}
                </div>
                <p className="border-t border-zinc-800 px-3.5 py-2 text-[10.5px] leading-relaxed text-zinc-600">
                  Deep turns run multi-round audited search when Search is on —
                  plan → retrieve → cross-check — and always show their sources.
                </p>
              </PopoverContent>
            </Popover>

            {/* Duel — race two models on one question, keep the winner.
                Only a pooled gateway can offer this in-chat. */}
            <button
              onClick={() => {
                if (!duelEnabled && duelAvailable) {
                  toast({
                    description:
                      "Duel armed — next message races two models; you pick the keeper.",
                  });
                }
                toggleDuel();
              }}
              disabled={!duelAvailable}
              aria-pressed={duelEnabled}
              className={`hidden h-9 w-9 shrink-0 items-center justify-center gap-1.5 rounded-full border text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:flex sm:h-8 sm:w-auto sm:px-2.5 ${
                duelEnabled
                  ? "border-amber-300/70 bg-amber-300/10 text-amber-200"
                  : "border-zinc-600 text-zinc-300 hover:bg-white/5"
              }`}
              title={duelAvailable ? "Duel — send to two models at once, keep the better answer (bills both)" : "Add a second model to the active provider to duel"}
            >
              <Swords className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Duel</span>
            </button>

            {/* Challenger picker — shown while duel is armed */}
            {duelEnabled && challenger && (
              <Popover open={challengerOpen} onOpenChange={setChallengerOpen}>
                <PopoverTrigger asChild>
                  <button
                    aria-label="Pick the dueling challenger model"
                    title={`Challenger — currently ${modelMeta(challenger).name}`}
                    className="flex h-8 max-w-[92px] shrink-0 items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800/40 px-2.5 text-[12px] text-zinc-300 transition-colors hover:bg-white/5 sm:max-w-[170px]"
                  >
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-300/80">
                      vs
                    </span>
                    <span className="truncate font-medium">
                      {modelMeta(challenger).name}
                    </span>
                    <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="start"
                  className="w-60 rounded-xl border-zinc-800 bg-[#212121] p-0 shadow-2xl"
                >
                  <div className="border-b border-zinc-800 px-3.5 py-2.5">
                    <span className="text-[11px] font-semibold tracking-[0.12em] text-zinc-400">
                      CHALLENGER MODEL
                    </span>
                  </div>
                  <div className="hermes-scroll max-h-72 overflow-y-auto py-1">
                    {models
                      .filter((m) => m !== model)
                      .map((m) => {
                        const meta = modelMeta(m);
                        const glyph = modelGlyph(m);
                        return (
                          <button
                            key={m}
                            onClick={() => {
                              setChallenger(m);
                              setChallengerOpen(false);
                            }}
                            title={m}
                            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-white/5 ${
                              m === challenger ? "text-white" : "text-zinc-300"
                            }`}
                          >
                            <span
                              aria-hidden
                              className={`flex h-[22px] w-[30px] shrink-0 items-center justify-center rounded-md text-[9px] font-bold tracking-wide ${glyph.cls}`}
                            >
                              {glyph.tag}
                            </span>
                            <span className="min-w-0 flex-1 truncate font-medium">
                              {meta.name}
                            </span>
                            {m === challenger ? (
                              <Check className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                            ) : (
                              modelHint(meta) && (
                                <span className="shrink-0 text-[11px] text-zinc-500">
                                  {modelHint(meta)}
                                </span>
                              )
                            )}
                          </button>
                        );
                      })}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>

          {/* right controls — model chip, then mic + send in the
              thumb zone; min-w-0 + truncation keep narrow phones calm */}
          <div className="flex min-w-0 items-center gap-1.5">
            {/* model selector — pretty name + tier badge + caret */}
            <Popover open={modelOpen} onOpenChange={setModelOpen}>
              <PopoverTrigger asChild>
                <button
                  aria-label="Select model"
                  title={model}
                  className="flex h-8 min-w-0 max-w-[210px] items-center gap-1.5 rounded-full border border-zinc-600 px-2 text-[13px] text-zinc-200 transition-colors hover:bg-white/5 sm:px-2.5"
                >
                  <span className="truncate font-medium">{activeMeta.name}</span>
                  {activeMeta.tier && (
                    <span className="hidden shrink-0 rounded-full border border-zinc-600 bg-zinc-800/60 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-zinc-400 sm:inline">
                      {activeMeta.tier}
                    </span>
                  )}
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="end"
                className="w-[300px] max-w-[calc(100vw-24px)] rounded-xl border-zinc-800 bg-[#212121] p-0 shadow-2xl"
              >
                <div className="flex items-center justify-between border-b border-zinc-800 px-3.5 py-2.5">
                  <span className="text-[11px] font-semibold tracking-[0.12em] text-zinc-400">
                    SELECT MODEL
                  </span>
                  <div className="flex items-center gap-2">
                    {models.length > 0 && (
                      <span
                        title={`${models.length} models live on ${providerName ?? "the active provider"}`}
                        className="rounded-full border border-zinc-700 bg-zinc-800/60 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-zinc-400"
                      >
                        {models.length} live
                      </span>
                    )}
                  <button
                    onClick={async () => {
                      setSyncing(true);
                      const synced = await syncModels();
                      setSyncing(false);
                      toast({
                        description: synced
                          ? "Model list synced from provider."
                          : "Provider sync unavailable — using cached list.",
                      });
                    }}
                    className="flex items-center gap-1 text-[12px] text-zinc-300 hover:text-white"
                  >
                    <RefreshCw
                      className={`h-3 w-3 ${syncing ? "animate-spin" : ""}`}
                    />
                    Sync
                  </button>
                  </div>
                </div>
                <div className="hermes-scroll max-h-80 overflow-y-auto py-1">
                  {models.length === 0 && (
                    <p className="px-3.5 py-2 text-[13px] text-zinc-500">
                      No models configured
                    </p>
                  )}
                  {/* provider group header — shown ONCE, not stacked
                      on every model */}
                  {models.length > 0 && providerName && (
                    <p className="px-3.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                      {providerName}
                    </p>
                  )}
                  {models.map((m) => {
                    const meta = modelMeta(m);
                    const hint = modelHint(meta);
                    const glyph = modelGlyph(m);
                    return (
                      <button
                        key={m}
                        onClick={() => {
                          setModel(m);
                          setModelOpen(false);
                        }}
                        title={m}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-white/5 ${
                          m === model ? "text-white" : "text-zinc-300"
                        }`}
                      >
                        <span
                          aria-hidden
                          className={`flex h-[22px] w-[30px] shrink-0 items-center justify-center rounded-md text-[9px] font-bold tracking-wide ${glyph.cls}`}
                        >
                          {glyph.tag}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {meta.name}
                        </span>
                        {m === model ? (
                          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                        ) : (
                          hint && (
                            <span className="shrink-0 text-[11px] text-zinc-500">
                              {hint}
                            </span>
                          )
                        )}
                      </button>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>

            {/* voice — record → server ASR → auto-send */}
            {isRecording ? (
              <>
                <button
                  onClick={recorder.cancel}
                  aria-label="Cancel recording"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-red-400"
                  title="Discard recording"
                >
                  <Trash2 className="h-[17px] w-[17px]" />
                </button>
                <button
                  onClick={() => void finishDictation()}
                  aria-label="Stop and send"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-500 text-white shadow-[0_0_0_4px_rgba(239,68,68,0.18)] transition-transform hover:scale-105"
                  title="Stop & send — transcribes and sends your message"
                >
                  <Square className="h-3 w-3 fill-white" />
                </button>
              </>
            ) : isProcessing ? (
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center text-zinc-400"
                aria-label="Transcribing and sending"
              >
                <Loader2 className="h-[18px] w-[18px] animate-spin" />
              </span>
            ) : (
              <>
                <button
                  onClick={() => setVoiceMode(true)}
                  aria-label="Open voice conversation"
                  title="H.E.R.M.E.S. Voice — talk hands-free, hear the replies spoken aloud"
                  className="group flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-transform hover:scale-105"
                >
                  <span
                    aria-hidden
                    className="block h-[22px] w-[22px] rounded-full bg-gradient-to-br from-amber-200 via-amber-400 to-orange-500 shadow-[0_0_10px_rgba(251,191,36,0.45)] transition-shadow group-hover:shadow-[0_0_16px_rgba(251,191,36,0.7)]"
                  />
                </button>
                <button
                  onClick={onMicClick}
                  aria-label="Start voice message"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-200"
                  title="Voice message — stop recording to transcribe and send it"
                >
                  <Mic className="h-[18px] w-[18px]" />
                </button>
                {streaming ? (
                  <button
                    onClick={stopStreaming}
                    aria-label="Stop generating"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-black transition-transform hover:scale-105"
                  >
                    <Square className="h-3.5 w-3.5 fill-black" />
                  </button>
                ) : (
                  <button
                    onClick={submit}
                    disabled={!canSend}
                    aria-label="Send message"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-black transition-all hover:scale-105 disabled:opacity-30 disabled:hover:scale-100"
                  >
                    <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.4} />
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <p className="pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 text-center text-[11px] text-zinc-600">
        Hermes can make mistakes. Verify important information.
      </p>
    </div>
  );
}
