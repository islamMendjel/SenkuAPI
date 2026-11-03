"use client";

// Hermes — message timeline: markdown rendering, message editing,
// quiet hover provenance line, cached badges, inline error recovery
// (retry · switch model), answer regenerate with variant history
// (‹ 2/3 › navigation, per-answer receipts) and capped search sources.

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Markdown } from "@/components/hermes/Markdown";
import {
  StreamedMarkdown,
  useStickyScroll,
} from "@/components/hermes/Typewriter";
import {
  ArrowLeftRight,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  Download,
  Eye,
  FileImage,
  FileText,
  Image as ImageIcon,
  Link2Off,
  Loader2,
  Maximize2,
  Pencil,
  RefreshCcw,
  Swords,
  TriangleAlert,
  Volume2,
  X,
} from "lucide-react";
import { useHermes, type DuelLane, type UIMessage } from "@/lib/store";
import { formatCompact } from "@/lib/hermes/format";
import { confidenceOf } from "@/lib/hermes/grounding";
import type { ConfidenceLabel } from "@/lib/hermes/grounding";
import { IMAGE_SIZES } from "@/lib/hermes/image-forge";
import { modelMeta } from "@/lib/hermes/models";
import type { AttachmentRecord, ImageRef } from "@/lib/hermes/types";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface SpeechActive {
  id: string;
  phase: "loading" | "playing";
}
type SpeechState = SpeechActive | null;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          // clipboard denied
        }
      }}
      aria-label="Copy raw markdown"
      title="Copy raw markdown"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400/80 transition-colors hover:bg-white/10 hover:text-zinc-100"
    >
      {copied ? (
        <Check className="h-4 w-4 text-emerald-400" />
      ) : (
        <Copy className="h-4 w-4" />
      )}
    </button>
  );
}

function SourcesBlock({ sources }: { sources: NonNullable<UIMessage["sources"]> }) {
  // >3 results can only come from the deep-research pipeline
  // (medium search is capped at 3) — say so, and scroll.
  const deep = sources.length > 3;
  return (
    <div className="mt-3 rounded-xl border border-zinc-800 bg-[#1d1d20] p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
        <RefreshCcw className="h-3 w-3" />
        {deep
          ? `Deep research · ${sources.length} sources`
          : `Searched the web · ${sources.length} result${
              sources.length === 1 ? "" : "s"
            }`}
      </div>
      <div
        className={`space-y-2.5${deep ? " hermes-scroll max-h-96 overflow-y-auto pr-1" : ""}`}
      >
        {sources.map((s, i) => {
          let host = s.url;
          try {
            host = new URL(s.url).hostname.replace(/^www\./, "");
          } catch {
            /* keep raw */
          }
          return (
            <div key={i} className="min-w-0">
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block truncate text-[13px] font-medium text-zinc-200 hover:text-violet-300 hover:underline"
              >
                {s.title || host}
              </a>
              <p className="text-[11px] text-zinc-500">
                {host}
                {s.dateHint ? ` · dated: ${s.dateHint}` : ""}
              </p>
              {s.snippet && (
                <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-zinc-400">
                  {s.snippet}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Files that were actually read on a user message — compact
 *  chips INSIDE the bubble, showing what the model received. */
function AttachmentChips({ attachments }: { attachments: AttachmentRecord[] }) {
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {attachments.map((a, i) => {
        const Icon = a.kind === "image" ? FileImage : FileText;
        const label =
          a.kind === "image"
            ? `vision · ${a.chars >= 1000 ? `${(a.chars / 1000).toFixed(1)}k` : a.chars} chars`
            : `${a.chars >= 1000 ? `${(a.chars / 1000).toFixed(1)}k` : a.chars} chars`;
        return (
          <span
            key={`${a.name}-${i}`}
            title={
              a.truncated
                ? `${a.name} — the model received the first ${a.chars} of ${a.totalChars} characters`
                : `${a.name} — the model received all ${a.chars} characters${a.kind === "image" ? " (vision pass: OCR + description)" : ""}`
            }
            className="flex max-w-full items-center gap-1.5 rounded-lg border border-zinc-600/80 bg-black/25 px-2 py-1 text-[11.5px] text-zinc-300"
          >
            {a.kind === "image" ? (
              <Eye className="h-3 w-3 shrink-0 text-zinc-400" aria-hidden />
            ) : (
              <Icon className="h-3 w-3 shrink-0 text-zinc-400" aria-hidden />
            )}
            <span className="truncate font-medium">{a.name}</span>
            <span className="shrink-0 text-zinc-500">{label}</span>
            {a.truncated && (
              <span className="shrink-0 text-amber-400/70" aria-label="truncated">
                ✂
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function UserMessage({ message }: { message: UIMessage }) {
  const { editMessage, streaming, rituals } = useHermes();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  if (editing) {
    return (
      <div className="flex flex-col items-end gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-[80px] w-full max-w-[85%] rounded-2xl border-zinc-600 bg-[#262627] text-[15px] text-zinc-100 focus-visible:ring-zinc-500"
          autoFocus
        />
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 rounded-full px-3 text-[12px] text-zinc-400 hover:bg-white/5 hover:text-white"
            onClick={() => {
              setDraft(message.content);
              setEditing(false);
            }}
          >
            <X className="mr-1 h-3 w-3" /> Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 rounded-full bg-white px-3 text-[12px] font-medium text-black hover:bg-zinc-200"
            disabled={streaming || !draft.trim()}
            onClick={() => {
              setEditing(false);
              void editMessage(message.id, draft.trim());
            }}
          >
            <Check className="mr-1 h-3 w-3" /> Save & submit
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group hermes-fade-up flex flex-col items-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-white/[0.07] bg-gradient-to-br from-[#34322d] to-[#2a2a29] px-4 py-2.5 text-[15px] leading-relaxed text-zinc-100 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.4)]">
        {message.imageRequest && (
          <span
            className="mb-1.5 flex w-fit items-center gap-1.5 rounded-lg border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[11px] text-amber-200"
            title={`Forged at ${IMAGE_SIZES[message.imageRequest.size].dims}`}
          >
            <ImageIcon className="h-3 w-3 shrink-0" aria-hidden />
            Image · {IMAGE_SIZES[message.imageRequest.size].dims}
          </span>
        )}
        {message.ritualId && (
          <span
            className="mb-1.5 flex w-fit items-center gap-1.5 rounded-lg border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[11px] text-amber-200"
            title="Sent by a scheduled ritual — nobody typed this"
          >
            <CalendarClock className="h-3 w-3 shrink-0" aria-hidden />
            Ritual ·{" "}
            {rituals.find((r) => r.id === message.ritualId)?.title ?? "scheduled"}
          </span>
        )}
        {message.attachments?.length ? (
          <AttachmentChips attachments={message.attachments} />
        ) : null}
        {message.content}
      </div>
      {message.sources && message.sources.length > 0 && (
        <div className="w-full max-w-[85%]">
          <SourcesBlock sources={message.sources} />
        </div>
      )}
      <div className="mt-1 flex items-center gap-1 hermes-hover-actions">
        <CopyButton text={message.content} />
        <button
          onClick={() => {
            setDraft(message.content);
            setEditing(true);
          }}
          aria-label="Edit message"
          title="Edit message"
          className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400/80 transition-colors hover:bg-white/10 hover:text-zinc-100"
        >
          <Pencil className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/** One quiet provenance line: "GLM 5.3 · APInex pool · 1.9k tokens · cache: hit". */
function provenanceLine(m: UIMessage): string {
  // Run 22 — forged images carry their own receipt: dimensions, file
  // size, forge duration, and the fact that zero pool tokens were
  // spent (the forge runs on the Z.ai image engine, not the pool).
  if (m.image) {
    const parts = ["Image Forge", `${m.image.width}×${m.image.height}`];
    if (m.image.bytes > 0) {
      parts.push(
        m.image.bytes >= 1024 * 1024
          ? `${(m.image.bytes / (1024 * 1024)).toFixed(1)} MB`
          : `${Math.max(1, Math.round(m.image.bytes / 1024))} KB`
      );
    }
    if (m.image.ms > 0) parts.push(`${(m.image.ms / 1000).toFixed(1)}s`);
    parts.push("0 pool tokens");
    return parts.join(" · ");
  }
  const parts: string[] = [];
  // The effort dial leaves its mark — fast/deep turns say so.
  if (m.effort === "fast") parts.push("Fast mode");
  if (m.effort === "deep") parts.push("Deep research");
  if (m.model) parts.push(modelMeta(m.model).name);
  if (m.provider) {
    parts.push(
      m.servedBy === "zai-cloud"
        ? `${m.provider} · cloud failover`
        : `${m.provider} pool`
    );
  }
  if (typeof m.tokens === "number" && m.tokens > 0) {
    // Estimated counts (upstream sent no usage stats) say so — an
    // estimate is never presented as exact usage (Run 17).
    parts.push(
      m.tokensEstimated
        ? `≈${formatCompact(m.tokens)} tokens (estimated)`
        : `${formatCompact(m.tokens)} tokens`
    );
  }
  parts.push(m.cached ? "cache: hit" : "cache: miss");
  return parts.join(" · ");
}

/** Body without the trailing label line (display only). */
function withoutConfidenceLine(content: string): string {
  if (!confidenceOf(content)) return content;
  const lines = content.trimEnd().split("\n");
  return lines.slice(0, -1).join("\n").trimEnd();
}

const CONFIDENCE_STYLE: Record<ConfidenceLabel, { dot: string; text: string }> = {
  confirmed: { dot: "bg-emerald-400", text: "text-emerald-300/90" },
  partial: { dot: "bg-amber-400", text: "text-amber-300/90" },
  "stale sources": { dot: "bg-rose-400", text: "text-rose-300/90" },
};

function ConfidenceBadge({ label }: { label: ConfidenceLabel }) {
  const s = CONFIDENCE_STYLE[label];
  return (
    <div className="mt-1.5 flex items-center gap-1.5" aria-label={`Answer confidence: ${label}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} aria-hidden />
      <span className={`text-[11px] font-medium lowercase tracking-wide ${s.text}`}>
        {label}
      </span>
      <span
        className="text-[10.5px] text-zinc-600"
        title="Grounded-answer confidence — dates and sources were audited against your question's time scope"
      >
        · source confidence
      </span>
    </div>
  );
}

/** One racing model inside a duel: header (lane badge · model · Keep
    button), thinking/streaming/error body, per-lane confidence badge. */
function DuelLaneCard({
  lane,
  canPick,
  onKeep,
}: {
  lane: DuelLane;
  canPick: boolean;
  onKeep: () => void;
}) {
  const meta = modelMeta(lane.model);
  // Grounded-answer contract, per lane: the trailing label becomes
  // a badge once this lane finishes streaming.
  const confidence = !lane.streaming && !lane.error ? confidenceOf(lane.content) : null;
  const display = confidence ? withoutConfidenceLine(lane.content) : lane.content;
  const keepable = canPick && !lane.error && lane.content.trim().length > 0;

  return (
    <div
      className={`flex min-w-0 flex-col rounded-xl border p-3 ${
        lane.error ? "border-red-500/25 bg-red-500/5" : "border-zinc-800 bg-[#1d1d20]"
      }`}
      aria-label={`Duel lane ${lane.id.toUpperCase()} — ${meta.name}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800/60 text-[10px] font-bold uppercase text-zinc-400"
          aria-hidden
        >
          {lane.id}
        </span>
        <span
          className="min-w-0 truncate text-[12.5px] font-semibold text-zinc-200"
          title={lane.model}
        >
          {meta.name}
        </span>
        {lane.cached && !lane.error && (
          <span
            className="flex shrink-0 items-center gap-1 text-emerald-400/70"
            title="Served from the 24h response cache — zero tokens spent"
          >
            <Database className="h-3 w-3" />
          </span>
        )}
        <span className="ml-auto shrink-0">
          <button
            onClick={onKeep}
            disabled={!keepable}
            className={`flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition-colors ${
              keepable
                ? "border-zinc-500/60 bg-white/10 text-zinc-100 hover:bg-white/20"
                : "cursor-not-allowed border-zinc-800 text-zinc-600"
            }`}
            title={
              keepable
                ? `Keep the ${meta.name} answer`
                : lane.error
                  ? "This lane failed"
                  : "Waiting for this answer to finish…"
            }
          >
            <Check className="h-3 w-3" />
            Keep
          </button>
        </span>
      </div>

      <div className="min-w-0">
        {lane.error ? (
          <p className="text-[12.5px] leading-relaxed text-red-300/80" role="alert">
            {lane.error}
          </p>
        ) : lane.phase && !lane.content ? (
          <div className="flex h-6 items-center" aria-live="polite">
            <span className="hermes-thinking-label text-[13px] font-medium">
              {lane.phase === "searching" ? "Searching the web" : "Thinking"}
            </span>
          </div>
        ) : (
          <StreamedMarkdown content={display} streaming={lane.streaming} />
        )}
      </div>

      {!lane.streaming && confidence && <ConfidenceBadge label={confidence} />}
    </div>
  );
}

/** A duel turn awaiting its pick: two models racing side by side
    (stacked on mobile), each with its own Keep button. */
function DuelMessage({ message }: { message: UIMessage }) {
  const { pickDuelWinner } = useHermes();
  const { toast } = useToast();
  const duel = message.duel;
  if (!duel) return null;
  // Picks unlock once the turn finishes (or is stopped) — picking
  // mid-stream would race the lane_done/done reconciliation.
  const canPick = !message.streaming;

  const keep = (lane: "a" | "b") => {
    const meta = modelMeta(duel[lane].model);
    void pickDuelWinner(message.id, lane).then(() => {
      toast({
        description: `Kept ${meta.name} — the runner-up stays under the answer.`,
      });
    });
  };

  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-amber-300/70">
        <Swords className="h-3 w-3" aria-hidden />
        Duel — pick the keeper
      </div>
      <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2">
        <DuelLaneCard lane={duel.a} canPick={canPick} onKeep={() => keep("a")} />
        <DuelLaneCard lane={duel.b} canPick={canPick} onKeep={() => keep("b")} />
      </div>
      <p className="mt-2 text-[11px] text-zinc-600">
        Both answers are billed separately ·{" "}
        {canPick
          ? "pick one to keep it in the chat"
          : "generating both answers…"}
      </p>
    </div>
  );
}

/** Run 22 — the Image Forge's live generating card. A shimmering
 *  placeholder at the chosen aspect ratio with a real elapsed-seconds
 *  counter (the forge takes 30–90s — the number proves it's alive). */
function ImageForgePending() {
  const imageSize = useHermes((s) => s.imageSize);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = IMAGE_SIZES[imageSize];
  return (
    <div
      className="hermes-forge-card relative w-full max-w-[min(440px,100%)] overflow-hidden rounded-xl border border-amber-300/20 bg-[#1d1d20]"
      role="status"
      aria-live="polite"
      style={{ aspectRatio: `${s.width} / ${s.height}` }}
    >
      <div className="hermes-forge-shimmer absolute inset-0" aria-hidden />
      <div className="relative flex h-full w-full flex-col items-center justify-center gap-2.5 p-6">
        <ImageIcon
          className="h-7 w-7 text-amber-300 hermes-float"
          aria-hidden
        />
        <p className="hermes-thinking-label text-[14px] font-medium">
          Forging your image…
        </p>
        <p className="text-[11.5px] tabular-nums text-zinc-500">
          {elapsed}s · the forge usually takes 30–90s · {s.dims}
        </p>
      </div>
    </div>
  );
}

/** Run 22 — a settled forged image: rounded card, hover-zoom affordance,
 *  click → fullscreen lightbox (Esc closes), one-click download, prompt
 *  caption. Served from the local file route with immutable caching. */
function GeneratedImageCard({ image }: { image: ImageRef }) {
  const [zoom, setZoom] = useState(false);
  const url = `/api/image/file/${image.id}`;

  // Esc closes the lightbox — the keyboard path is first-class.
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoom(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);

  return (
    <figure className="hermes-fade-up mt-0.5 w-full max-w-[min(480px,100%)]">
      <button
        type="button"
        onClick={() => setZoom(true)}
        aria-label="Open image full size"
        title="Open full size"
        className="group relative block w-full overflow-hidden rounded-xl border border-zinc-800 bg-[#1d1d20] transition-colors hover:border-zinc-600"
      >
        {/* Plain img: the file route serves with immutable caching and
            exact dimensions — next/image adds nothing here. */}
        <img
          src={url}
          alt={`Generated image — ${image.prompt}`}
          width={image.width}
          height={image.height}
          className="h-auto w-full"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/30 group-hover:opacity-100"
        >
          <Maximize2 className="h-5 w-5 text-white drop-shadow" />
        </span>
      </button>
      <figcaption className="mt-1.5 flex items-center justify-between gap-2">
        <span
          className="min-w-0 truncate text-[11.5px] text-zinc-500"
          title={image.prompt}
        >
          {image.prompt}
        </span>
        <a
          href={`${url}?download=1`}
          download
          aria-label="Download image"
          title="Download image"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
        >
          <Download className="h-3.5 w-3.5" />
        </a>
      </figcaption>

      {zoom && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/90 p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Generated image — full size"
          onClick={() => setZoom(false)}
        >
          <img
            src={url}
            alt={`Generated image — ${image.prompt}`}
            className="max-h-[80vh] max-w-full cursor-zoom-out rounded-lg object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <div
            className="flex items-center gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-[12px] tabular-nums text-zinc-400">
              {image.width}×{image.height}
            </span>
            <a
              href={`${url}?download=1`}
              download
              className="flex h-8 items-center gap-1.5 rounded-full border border-zinc-600 bg-white/10 px-3.5 text-[12px] font-medium text-zinc-100 transition-colors hover:bg-white/20"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </a>
            <button
              type="button"
              onClick={() => setZoom(false)}
              className="flex h-8 items-center gap-1.5 rounded-full border border-zinc-700 px-3.5 text-[12px] text-zinc-300 transition-colors hover:bg-white/10"
            >
              <X className="h-3.5 w-3.5" />
              Close
            </button>
          </div>
        </div>
      )}
    </figure>
  );
}

function AssistantMessage({
  message,
  speech,
  onToggleSpeech,
  isLast,
}: {
  message: UIMessage;
  speech: SpeechState;
  onToggleSpeech: (m: UIMessage) => void;
  isLast: boolean;
}) {
  const { models, model, setModel, retryLast, streaming, regenerate, navigateVariant } =
    useHermes();
  const isThinking = message.streaming && !message.content && !message.error;
  const isSpeakingThis = speech?.id === message.id;
  const speechLoading = isSpeakingThis && speech.phase === "loading";
  const speechPlaying = isSpeakingThis && speech.phase === "playing";

  // Error recovery: the next model in the list (wraps around).
  const currentIdx = models.indexOf(model);
  const switchTarget =
    models.length > 1
      ? models[((currentIdx === -1 ? 0 : currentIdx) + 1) % models.length]
      : null;

  // Grounded-answer contract: the trailing confidence label becomes
  // a badge once streaming completes (while streaming, the final
  // line may still be half-written — render it raw).
  const confidence = message.error ? null : confidenceOf(message.content);
  const displayContent =
    !message.streaming && confidence
      ? withoutConfidenceLine(message.content)
      : message.content;
  // Run 22 — image turns never offer "switch model" retries: the
  // forge is a single engine, retrying re-forges the same prompt.
  const isForgeError = message.error && message.model === "image-forge";

  return (
    <div className="group hermes-fade-up">
      <div className="flex gap-3">
        {/* While thinking, our own WHITE sparkle logo pulses with the
            exact scale curve measured from the Claude Code reference
            GIF — same motion, our colors — beside a shimmering label. */}
        <Image
          src="/hermes-mark.png"
          alt="Hermes"
          width={28}
          height={28}
          className={`mt-0.5 h-7 w-7 shrink-0 object-contain object-center${
            isThinking ? " hermes-thinking-sparkle" : ""
          }`}
        />
        <div className="min-w-0 flex-1">
          {message.error ? (
            <div
              className="rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[13px] text-red-300"
              role="alert"
            >
              <p className="leading-relaxed">{message.error}</p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void retryLast()}
                  disabled={streaming}
                  className="flex h-7 items-center gap-1.5 rounded-full border border-zinc-500/60 bg-white/10 px-3 text-[12px] font-medium text-zinc-100 transition-colors hover:bg-white/20 disabled:opacity-40"
                >
                  <RefreshCcw className="h-3 w-3" />
                  {isForgeError ? "Retry the forge" : "Retry"}
                </button>
                {switchTarget && !isForgeError && (
                  <button
                    onClick={() => {
                      setModel(switchTarget);
                      void retryLast(switchTarget);
                    }}
                    disabled={streaming}
                    className="flex h-7 items-center gap-1.5 rounded-full border border-zinc-700 px-3 text-[12px] text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200 disabled:opacity-40"
                    title={`Retry with ${modelMeta(switchTarget).name}`}
                  >
                    <ArrowLeftRight className="h-3 w-3" />
                    Switch model
                  </button>
                )}
              </div>
            </div>
          ) : message.duel ? (
            /* Awaiting-pick duel: two racing lanes instead of one
               answer — per-lane thinking, streaming, badges, Keep. */
            <DuelMessage message={message} />
          ) : message.imagePending ? (
            /* Run 22 — the forge is running: live shimmer card with a
               real elapsed counter (30–90s, honestly labeled). */
            <ImageForgePending />
          ) : message.image ? (
            /* Run 22 — a settled forged image (variant swaps included). */
            <GeneratedImageCard image={message.image} />
          ) : isThinking ? (
            <div className="flex h-7 items-center" aria-live="polite">
              <span className="hermes-thinking-label text-[14px] font-medium">
                {message.phase === "searching"
                  ? message.searchDetail ?? "Searching the web"
                  : message.effort === "deep"
                    ? "Thinking deeply"
                    : "Thinking"}
              </span>
            </div>
          ) : (
            <StreamedMarkdown
              content={displayContent}
              streaming={Boolean(message.streaming)}
            />
          )}

          {/* grounded-answer confidence badge (search turns) */}
          {!message.streaming && !message.duel && confidence && (
            <ConfidenceBadge label={confidence} />
          )}

          {/* search-failure notice (all engines down) */}
          {!message.streaming && message.searchFailed && !message.error && (
            <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-amber-400/80">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
              Web search unavailable — answered from model knowledge.
            </div>
          )}

          {/* quiet provenance line + hover actions (desktop reveals on
              hover; touch devices keep it faintly visible). Run 21:
              variant history navigation (‹ 2/3 ›) and — on the last
              settled answer — regenerate live here too. */}
          {!message.streaming && !message.error && !message.duel && (
            <div className="mt-2 flex items-center gap-1 hermes-meta-row">
              {/* answer variants: flip through this turn's earlier
                  answers; each carries its own honest receipt */}
              {message.variants &&
                message.variants.length > 0 &&
                message.variantIndex != null && (
                  <span
                    className="flex shrink-0 items-center gap-0.5"
                    role="group"
                    aria-label="Answer versions"
                  >
                    <button
                      onClick={() => void navigateVariant(message.id, -1)}
                      disabled={streaming || message.variantIndex === 0}
                      aria-label="Previous answer version"
                      title="Previous answer"
                      className="flex h-7 w-5 items-center justify-center rounded-md text-zinc-400/80 transition-colors hover:bg-white/10 hover:text-zinc-100 disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <span
                      className="min-w-[30px] text-center text-[11px] tabular-nums text-zinc-500"
                      aria-live="polite"
                    >
                      {(message.variantIndex ?? 0) + 1}/{message.variants.length}
                    </span>
                    <button
                      onClick={() => void navigateVariant(message.id, 1)}
                      disabled={
                        streaming ||
                        message.variantIndex === message.variants.length - 1
                      }
                      aria-label="Next answer version"
                      title="Next answer"
                      className="flex h-7 w-5 items-center justify-center rounded-md text-zinc-400/80 transition-colors hover:bg-white/10 hover:text-zinc-100 disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </span>
              )}
              {/* regenerate: one click re-rolls the last answer — the
                  current one is kept as a viewable variant */}
              {isLast && !message.runnerUp && message.content.trim() && (
                <button
                  onClick={() => void regenerate()}
                  disabled={streaming}
                  aria-label="Regenerate this answer"
                  title="Regenerate — the current answer stays in the version history"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400/80 transition-colors hover:bg-white/10 hover:text-zinc-100 disabled:opacity-40"
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                </button>
              )}
              <CopyButton text={message.content} />
              {message.content.trim() && (
                <button
                  onClick={() => onToggleSpeech(message)}
                  aria-label={
                    speechPlaying ? "Stop reading aloud" : "Read this answer aloud"
                  }
                  aria-pressed={speechPlaying}
                  title={speechPlaying ? "Stop reading aloud" : "Read aloud"}
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${
                    speechPlaying
                      ? "text-emerald-300"
                      : "text-zinc-400/80 hover:bg-white/10 hover:text-zinc-100"
                  }`}
                >
                  {speechLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : speechPlaying ? (
                    <span className="hermes-eq flex h-4 items-end gap-[2px]" aria-hidden>
                      <span />
                      <span />
                      <span />
                    </span>
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )}
                </button>
              )}
              {message.cached && (
                <span
                  className="flex shrink-0 items-center gap-1 text-[11px] text-emerald-400/80"
                  title="Served from the 24h response cache — zero tokens spent"
                >
                  <Database className="h-3 w-3" />
                </span>
              )}
              <span
                className="ml-0.5 truncate text-[11px] text-zinc-500"
                title={provenanceLine(message)}
              >
                {provenanceLine(message)}
              </span>
            </div>
          )}

          {/* duel runner-up: the losing lane stays viewable under the
              kept answer (collapsed, muted — a reference, not the reply) */}
          {!message.streaming && !message.error && message.runnerUp?.content && (
            <details className="mt-2">
              <summary
                className="flex w-fit cursor-pointer select-none items-center gap-1.5 text-[11.5px] text-zinc-500 transition-colors hover:text-zinc-300 [&::-webkit-details-marker]:hidden"
                title="The other model's answer from this duel"
              >
                <ChevronDown
                  className="h-3 w-3 transition-transform"
                  aria-hidden
                />
                Runner-up · {modelMeta(message.runnerUp.model).name}
              </summary>
              <div className="hermes-md mt-2 rounded-xl border border-zinc-800/70 bg-[#1d1d20]/60 px-3.5 py-2.5">
                <Markdown
                  content={
                    confidenceOf(message.runnerUp.content)
                      ? withoutConfidenceLine(message.runnerUp.content)
                      : message.runnerUp.content
                  }
                />
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

export function TemporaryBanner() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-2">
      <div className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-[#1d1d20] px-3.5 py-2.5 text-[13px] text-zinc-400">
        <Link2Off className="h-4 w-4 shrink-0 text-zinc-500" />
        <span>
          <span className="font-medium text-zinc-300">Temporary Chat</span>{" "}
          • Messages in this chat won&apos;t be saved to chat history.
        </span>
      </div>
    </div>
  );
}

export function ChatTimeline() {
  const { messages, highlightMessageId, flashMessage } = useHermes();
  const { toast } = useToast();
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Auto-scroll stickiness: following the newest word pauses the
  // moment the user scrolls up to read and resumes when they return
  // to the bottom (every StreamedMarkdown consults the same state).
  const stickRef = useStickyScroll(scrollRef);

  // ── Read-aloud (TTS) playback state ──
  // One audio element for the whole timeline; only one message can
  // speak at a time. A token guards against stale fetches after a stop.
  const [speech, setSpeech] = useState<SpeechState>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const speechTokenRef = useRef(0);

  const stopSpeech = () => {
    speechTokenRef.current += 1;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    setSpeech(null);
  };

  const toggleSpeech = async (m: UIMessage) => {
    if (speech?.id === m.id) {
      stopSpeech();
      return;
    }
    stopSpeech();
    const token = ++speechTokenRef.current;
    setSpeech({ id: m.id, phase: "loading" });
    try {
      const res = await fetch("/api/voice/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: m.content }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Read-aloud is unavailable right now.");
      }
      if (token !== speechTokenRef.current) return; // user moved on
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      const audio = (audioRef.current ??= new Audio());
      audio.src = url;
      audio.onended = () => {
        if (token === speechTokenRef.current) stopSpeech();
      };
      audio.onerror = () => {
        if (token === speechTokenRef.current) stopSpeech();
      };
      await audio.play();
      if (token !== speechTokenRef.current) return;
      setSpeech({ id: m.id, phase: "playing" });
    } catch (e) {
      if (token === speechTokenRef.current) {
        setSpeech(null);
        if ((e as Error).name !== "NotAllowedError") {
          toast({
            description: (e as Error).message || "Could not play the audio.",
            variant: "destructive",
          });
        }
      }
    }
  };

  // stop playback when the timeline unmounts or the chat changes
  useEffect(() => {
    return () => {
      speechTokenRef.current += 1;
      audioRef.current?.pause();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  // Scroll for NEW messages only — content growth is followed
  // word-by-word by the typewriter gate — and never yank the view
  // back down if the user has scrolled up.
  const count = messages.length;
  const lastId = messages[count - 1]?.id ?? "";
  useEffect(() => {
    if (!stickRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [count, lastId, stickRef]);

  // Run 26 — jump-to-message from ⌘K content search. When the store
  // carries a highlight target AND that message is mounted, center it
  // (double-rAF so the enter-chat bottom-scroll settles first) and
  // hold the flash ring ~2.4s before clearing. If the message isn't
  // mounted yet (chats load async), the effect re-arms on the next
  // messages update — no timers, no polling.
  useEffect(() => {
    if (!highlightMessageId) return;
    const el = scrollRef.current?.querySelector(
      `[data-message-id="${highlightMessageId}"]`
    );
    if (!el) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
    const t = window.setTimeout(() => flashMessage(null), 2400);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(t);
    };
  }, [highlightMessageId, messages, flashMessage]);

  // Run 30 — reading cues: the top fade proves there is content above
  // (on the moment the timeline is scrolled) and the jump pill appears
  // once the reader drifts more than ~240px from the newest message.
  // Both live off one passive scroll listener; direct state writes
  // (no rAF) — a class toggle per scroll event is cheap, and React
  // bails out when the booleans don't change.
  const [scrolledTop, setScrolledTop] = useState(false);
  const [offBottom, setOffBottom] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sync = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setScrolledTop(el.scrollTop > 6);
      setOffBottom(distance > 240);
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    return () => el.removeEventListener("scroll", sync);
  }, []);

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="hermes-timeline flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="hermes-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-7 px-4 pb-6 pt-5">
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div
              key={m.id}
              data-message-id={m.id}
              className={`rounded-2xl ${
                m.id === highlightMessageId ? "hermes-msg-flash" : ""
              }`}
            >
              <UserMessage message={m} />
            </div>
          ) : (
            /* Slot-stable key: the server reconciles the assistant
               message id at "done" — keying by id would remount the
               message right then and dump the typewriter's remaining
               reveal. The slot never shifts mid-turn (messages are
               append-only while streaming). */
            <div
              key={`slot-${i}`}
              data-message-id={m.id}
              className={`rounded-2xl ${
                m.id === highlightMessageId ? "hermes-msg-flash" : ""
              }`}
            >
              <AssistantMessage
                message={m}
                isLast={i === messages.length - 1}
                speech={speech}
                onToggleSpeech={(msg) => void toggleSpeech(msg)}
              />
            </div>
          )
        )}
        <div ref={bottomRef} />
        </div>
      </div>

      {/* reading cues — see the scroll-sync effect above for when each
          earns its visibility (aria-hidden fade; labeled button) */}
      <div
        aria-hidden
        className="hermes-tl-fade"
        data-on={scrolledTop ? "1" : "0"}
      />
      <button
        type="button"
        onClick={jumpToLatest}
        aria-label="Jump to the latest message"
        title="Jump to the latest message"
        className="hermes-jump"
        data-on={offBottom ? "1" : "0"}
      >
        <ChevronDown className="h-4 w-4" aria-hidden />
        Latest
      </button>
    </div>
  );
}
