"use client";

// Hermes — Rituals dialog (Run 34).
//
// The management surface for scheduled prompts: things Hermes does
// on their own clock, whether or not the app is open. Every ritual
// owns one dedicated chat — runs accumulate there, grounded and
// billed exactly like a typed turn, with honest receipts (status,
// tokens, run count). Honest by design, like the Memory dialog it
// sibling's after: the countdowns are live, the cap is real, the
// empty state teaches with one-click examples that fill the form.

import { useEffect, useRef, useState } from "react";
import {
  CalendarClock,
  CalendarPlus,
  Check,
  Globe,
  Loader2,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useHermes, type RitualItem } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { useNow } from "@/hooks/use-now";
import {
  RITUAL_MAX_ENTRIES,
  RITUAL_MAX_PROMPT_CHARS,
  RITUAL_MAX_TITLE_CHARS,
  RITUAL_MIN_INTERVAL_MIN,
  RITUAL_WEEKDAYS,
  ritualCountdown,
  ritualLocalTime,
  ritualScheduleSummary,
  USER_TIMEZONE_LABEL,
} from "@/lib/hermes/constants";

// ── One ritual row ────────────────────────────────────────────

function RitualRow({
  ritual,
  nowMs,
  onOpenChat,
}: {
  ritual: RitualItem;
  nowMs: number;
  onOpenChat: (chatId: string) => void;
}) {
  const { toggleRitual, editRitual, deleteRitual, runRitualNow } = useHermes();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(ritual.title);
  const [promptDraft, setPromptDraft] = useState(ritual.prompt);
  const [running, setRunning] = useState(false);

  // Drafts follow the store until the user starts editing (the
  // render-time prop-adjustment pattern — no effects, no cascades).
  const [synced, setSynced] = useState({ t: ritual.title, p: ritual.prompt });
  if (synced.t !== ritual.title || synced.p !== ritual.prompt) {
    setSynced({ t: ritual.title, p: ritual.prompt });
    if (!editing) {
      setTitleDraft(ritual.title);
      setPromptDraft(ritual.prompt);
    }
  }

  const save = async () => {
    const title = titleDraft.trim();
    const prompt = promptDraft.trim();
    if (!title || !prompt) {
      toast({
        variant: "destructive",
        description: "A ritual needs both a title and a prompt.",
      });
      return;
    }
    const ok = await editRitual(ritual.id, {
      ...(title !== ritual.title ? { title } : {}),
      ...(prompt !== ritual.prompt ? { prompt } : {}),
    });
    if (ok) {
      setEditing(false);
      toast({
        description: "Ritual updated — the next fire uses the new prompt.",
      });
    } else {
      toast({ variant: "destructive", description: "Could not update that ritual." });
    }
  };

  const run = async () => {
    if (running) return;
    setRunning(true);
    const res = await runRitualNow(ritual.id);
    setRunning(false);
    if (res.ok) {
      toast({ description: `Ran now — ${res.status ?? "done"}.` });
    } else {
      toast({ variant: "destructive", description: res.error ?? "Run failed." });
    }
  };

  if (editing) {
    return (
      <div className="space-y-2 rounded-xl border border-amber-400/25 bg-[#26251f] p-2.5">
        <input
          autoFocus
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value.slice(0, RITUAL_MAX_TITLE_CHARS))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
            if (e.key === "Escape") {
              setTitleDraft(ritual.title);
              setPromptDraft(ritual.prompt);
              setEditing(false);
            }
          }}
          aria-label="Ritual title"
          className="w-full rounded-lg border border-zinc-700/70 bg-[#18181b] px-2.5 py-1.5 text-[13px] font-medium text-zinc-100 outline-none placeholder:text-zinc-600 focus-visible:border-amber-400/40"
          placeholder="Title"
        />
        <textarea
          value={promptDraft}
          onChange={(e) => setPromptDraft(e.target.value.slice(0, RITUAL_MAX_PROMPT_CHARS))}
          rows={Math.min(5, Math.max(2, Math.ceil(promptDraft.length / 52)))}
          aria-label="Ritual prompt"
          className="w-full resize-none rounded-lg border border-zinc-700/70 bg-[#18181b] px-2.5 py-1.5 text-[12.5px] leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-600 focus-visible:border-amber-400/40"
          placeholder="What should Senku do?"
        />
        <div className="flex items-center justify-between">
          <span className="text-[10.5px] tabular-nums text-zinc-600">
            {promptDraft.length}/{RITUAL_MAX_PROMPT_CHARS}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => {
                setTitleDraft(ritual.title);
                setPromptDraft(ritual.prompt);
                setEditing(false);
              }}
              className="flex h-7 items-center gap-1 rounded-lg px-2.5 text-[12px] text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
            >
              <RotateCcw className="h-3 w-3" /> Cancel
            </button>
            <button
              onClick={() => void save()}
              className="flex h-7 items-center gap-1 rounded-lg bg-emerald-500/90 px-2.5 text-[12px] font-medium text-black transition-colors hover:bg-emerald-400"
            >
              <Check className="h-3 w-3" /> Save
            </button>
          </div>
        </div>
      </div>
    );
  }

  const schedule = ritualScheduleSummary(ritual);
  const statusOk = ritual.lastStatus?.startsWith("ok");

  return (
    <div
      className={`group rounded-xl border border-zinc-800 bg-[#1d1d20] p-2.5 transition-colors hover:border-zinc-700 ${
        ritual.isActive ? "" : "opacity-60"
      }`}
    >
      <div className="flex items-center gap-2">
        <CalendarClock
          className={`h-3.5 w-3.5 shrink-0 ${
            ritual.isActive ? "text-amber-300/90" : "text-zinc-600"
          }`}
          aria-hidden
        />
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-100">
          {ritual.title}
        </p>
        <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
          <button
            onClick={() => void run()}
            disabled={running}
            aria-label={`Run ${ritual.title} now`}
            title="Run now"
            className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-amber-400/15 hover:text-amber-300 disabled:cursor-wait"
          >
            {running ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Play className="h-3 w-3" />
            )}
          </button>
          <button
            onClick={() => onOpenChat(ritual.chatId)}
            aria-label={`Open the chat ${ritual.title} runs in`}
            title="Open chat"
            className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
          >
            <MessageSquare className="h-3 w-3" />
          </button>
          <button
            onClick={() => setEditing(true)}
            aria-label={`Edit ${ritual.title}`}
            title="Edit"
            className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            onClick={() => {
              void deleteRitual(ritual.id).then((ok) =>
                toast(
                  ok
                    ? {
                        description: `Ritual removed — its chat and history went with it.`,
                      }
                    : {
                        variant: "destructive",
                        description: "Could not delete that ritual.",
                      }
                )
              );
            }}
            aria-label={`Delete ${ritual.title}`}
            title="Delete"
            className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-red-500/15 hover:text-red-300"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-[22px] text-[11.5px]">
        <span className="tabular-nums text-zinc-400">{schedule}</span>
        {ritual.search && (
          <span className="inline-flex items-center gap-1 text-zinc-500">
            <Globe className="h-3 w-3" aria-hidden /> grounded
          </span>
        )}
        {ritual.isActive ? (
          <span className="tabular-nums text-amber-200/80">
            next {ritualLocalTime(ritual.nextRunAt)}
            {nowMs > 0 ? ` · ${ritualCountdown(ritual.nextRunAt, nowMs)}` : ""}
          </span>
        ) : (
          <span className="text-zinc-500 italic">paused</span>
        )}
        {ritual.runCount > 0 && (
          <span className="tabular-nums text-zinc-600">
            {ritual.runCount} run{ritual.runCount === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {ritual.lastStatus && (
        <p
          className={`mt-1 truncate pl-[22px] text-[11px] leading-snug ${
            statusOk ? "text-zinc-500" : "text-red-400/90"
          }`}
          title={ritual.lastStatus}
        >
          last: {ritual.lastStatus}
        </p>
      )}

      <div className="mt-1.5 flex items-center justify-between border-t border-zinc-800/70 pt-1.5 pl-[10px]">
        <p className="line-clamp-1 pl-3 text-[11.5px] text-zinc-500" title={ritual.prompt}>
          {ritual.prompt}
        </p>
        <Switch
          checked={ritual.isActive}
          onCheckedChange={(v) => {
            void toggleRitual(ritual.id, v).then((ok) =>
              toast(
                ok
                  ? {
                      description: v
                        ? "Resumed — the schedule picks up from now."
                        : "Paused — nothing fires until you resume.",
                    }
                  : {
                      variant: "destructive",
                      description: "Could not change that ritual.",
                    }
              )
            );
          }}
          aria-label={`Toggle ${ritual.title}`}
        />
      </div>
    </div>
  );
}

// ── Create form ───────────────────────────────────────────────

interface ScheduleDraft {
  kind: "daily" | "weekly" | "interval";
  hour: number;
  minute: number;
  weekday: number;
  intervalN: number;
  intervalUnit: "minutes" | "hours" | "days";
}

const EXAMPLES: { title: string; prompt: string; sched: ScheduleDraft }[] = [
  {
    title: "Morning AI brief",
    prompt:
      "Give me today's 3 most important AI developments — one tight paragraph each, with source links. Lead with anything genuinely surprising.",
    sched: { kind: "daily", hour: 8, minute: 0, weekday: 1, intervalN: 6, intervalUnit: "hours" },
  },
  {
    title: "Monday market pulse",
    prompt:
      "Summarize the past week's biggest tech-business stories in 5 bullets, each with a number that matters and its source.",
    sched: { kind: "weekly", hour: 9, minute: 0, weekday: 1, intervalN: 6, intervalUnit: "hours" },
  },
  {
    title: "Evening wind-down",
    prompt:
      "Share one genuinely surprising science story from today and why it matters. Under 150 words, include the source.",
    sched: { kind: "daily", hour: 21, minute: 30, weekday: 1, intervalN: 6, intervalUnit: "hours" },
  },
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => h);
const MINUTE_OPTIONS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

function ScheduleEditor({
  draft,
  onChange,
}: {
  draft: ScheduleDraft;
  onChange: (d: ScheduleDraft) => void;
}) {
  const selectCls =
    "h-8 rounded-lg border border-zinc-700/70 bg-[#18181b] px-1.5 text-[12.5px] tabular-nums text-zinc-200 outline-none focus-visible:border-amber-400/40";
  const labelCls = "text-[11.5px] text-zinc-500";

  return (
    <div className="space-y-2">
      {/* kind segmented control */}
      <div
        role="radiogroup"
        aria-label="Schedule type"
        className="flex gap-1 rounded-lg border border-zinc-800 bg-[#18181b] p-1"
      >
        {(
          [
            ["daily", "Daily"],
            ["weekly", "Weekly"],
            ["interval", "Every N"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="radio"
            aria-checked={draft.kind === k}
            onClick={() => onChange({ ...draft, kind: k })}
            className={`flex-1 rounded-md px-2 py-1 text-[12px] transition-colors ${
              draft.kind === k
                ? "bg-amber-400/15 font-medium text-amber-200"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {draft.kind === "interval" ? (
        <div className="flex items-center gap-2">
          <span className={labelCls}>Every</span>
          <input
            type="number"
            min={1}
            max={999}
            value={draft.intervalN}
            onChange={(e) =>
              onChange({
                ...draft,
                intervalN: Math.max(1, parseInt(e.target.value, 10) || 1),
              })
            }
            aria-label="Interval value"
            className="h-8 w-20 rounded-lg border border-zinc-700/70 bg-[#18181b] px-2 text-[12.5px] tabular-nums text-zinc-200 outline-none focus-visible:border-amber-400/40"
          />
          <select
            value={draft.intervalUnit}
            onChange={(e) =>
              onChange({
                ...draft,
                intervalUnit: e.target.value as ScheduleDraft["intervalUnit"],
              })
            }
            aria-label="Interval unit"
            className={selectCls}
          >
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {draft.kind === "weekly" && (
            <>
              <span className={labelCls}>On</span>
              <select
                value={draft.weekday}
                onChange={(e) =>
                  onChange({ ...draft, weekday: parseInt(e.target.value, 10) })
                }
                aria-label="Weekday"
                className={selectCls}
              >
                {RITUAL_WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </>
          )}
          <span className={labelCls}>At</span>
          <select
            value={draft.hour}
            onChange={(e) =>
              onChange({ ...draft, hour: parseInt(e.target.value, 10) })
            }
            aria-label="Hour"
            className={selectCls}
          >
            {HOUR_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, "0")}
              </option>
            ))}
          </select>
          <span className={labelCls}>:</span>
          <select
            value={draft.minute}
            onChange={(e) =>
              onChange({ ...draft, minute: parseInt(e.target.value, 10) })
            }
            aria-label="Minute"
            className={selectCls}
          >
            {MINUTE_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {String(m).padStart(2, "0")}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

// ── The dialog ────────────────────────────────────────────────

export function RitualsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { rituals, createRitual, refreshRituals, selectChat } = useHermes();
  const { toast } = useToast();
  const now = useNow();
  const nowMs = now ? now.getTime() : 0;

  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [search, setSearch] = useState(true);
  const [sched, setSched] = useState<ScheduleDraft>({
    kind: "daily",
    hour: 8,
    minute: 0,
    weekday: 1,
    intervalN: 6,
    intervalUnit: "hours",
  });
  const [creating, setCreating] = useState(false);
  const formRef = useRef<HTMLDivElement | null>(null);

  // Fresh state every time the dialog opens (render-time adjustment
  // keyed on the open flag — the MemoryDialog pattern), plus a live
  // poll while it stays open: countdowns and run statuses update on
  // their own, exactly like the forge's elapsed-time card.
  const [wasOpen, setWasOpen] = useState(false);
  if (open && !wasOpen) {
    setWasOpen(true);
    setTitle("");
    setPrompt("");
    setSearch(true);
    void refreshRituals();
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => void refreshRituals(), 30_000);
    return () => clearInterval(t);
  }, [open, refreshRituals]);

  const full = rituals.length >= RITUAL_MAX_ENTRIES;

  const intervalMinutes = (d: ScheduleDraft): number => {
    const f = d.intervalUnit === "minutes" ? 1 : d.intervalUnit === "hours" ? 60 : 1440;
    return d.intervalN * f;
  };

  const submit = async () => {
    if (creating) return;
    const t = title.trim();
    const p = prompt.trim();
    if (!t || !p) {
      toast({
        variant: "destructive",
        description: "A ritual needs a title and a prompt.",
      });
      return;
    }
    if (sched.kind === "interval" && intervalMinutes(sched) < RITUAL_MIN_INTERVAL_MIN) {
      toast({
        variant: "destructive",
        description: `The tightest interval is every ${RITUAL_MIN_INTERVAL_MIN} minutes.`,
      });
      return;
    }
    setCreating(true);
    const res = await createRitual({
      title: t,
      prompt: p,
      kind: sched.kind,
      hour: sched.hour,
      minute: sched.minute,
      weekday: sched.weekday,
      intervalMin: intervalMinutes(sched),
      search,
    });
    setCreating(false);
    if (res.ok) {
      setTitle("");
      setPrompt("");
      toast({
        description: `Scheduled — ${ritualScheduleSummary({
          kind: sched.kind,
          hour: sched.hour,
          minute: sched.minute,
          weekday: sched.weekday,
          intervalMin: intervalMinutes(sched),
        })}, ${USER_TIMEZONE_LABEL} time. It fires even when the app is closed.`,
      });
    } else {
      toast({
        variant: "destructive",
        description: res.error ?? "Could not schedule that ritual.",
      });
    }
  };

  const fillFromExample = (ex: (typeof EXAMPLES)[number]) => {
    setTitle(ex.title);
    setPrompt(ex.prompt);
    setSched(ex.sched);
    setSearch(true);
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const openChat = (chatId: string) => {
    onOpenChange(false);
    void selectChat(chatId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto rounded-2xl border-zinc-800 bg-[#212121] p-5 text-zinc-200">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold text-white">
            <CalendarClock className="h-4 w-4 text-amber-300" aria-hidden />
            Rituals
            <span className="ml-auto text-[11.5px] font-normal tabular-nums text-zinc-500">
              {rituals.length}/{RITUAL_MAX_ENTRIES}
            </span>
          </DialogTitle>
          <DialogDescription className="text-[12.5px] leading-snug text-zinc-500">
            Scheduled prompts Senku runs on its own clock — each fire lands
            in its own chat, grounded and billed like a turn you typed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 pt-1">
          {rituals.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-700/80 p-4">
              <p className="text-[13px] leading-relaxed text-zinc-400">
                Nothing scheduled yet. Senku can brief you every morning,
                pulse-check your week, or watch a topic — while you sleep:
              </p>
              <div className="mt-3 space-y-1.5">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex.title}
                    onClick={() => fillFromExample(ex)}
                    className="group flex w-full items-center gap-2 rounded-lg border border-zinc-800 bg-[#1d1d20] px-3 py-2 text-left text-[12.5px] text-zinc-300 transition-colors hover:border-amber-400/35 hover:text-zinc-100"
                  >
                    <Plus className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-colors group-hover:text-amber-300" />
                    <span className="min-w-0 flex-1 truncate">
                      {ex.title}
                      <span className="text-zinc-600">
                        {" "}
                        · {ritualScheduleSummary({
                          ...ex.sched,
                          intervalMin: ex.sched.intervalN *
                            (ex.sched.intervalUnit === "minutes"
                              ? 1
                              : ex.sched.intervalUnit === "hours"
                                ? 60
                                : 1440),
                        })}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            rituals.map((r) => (
              <RitualRow key={r.id} ritual={r} nowMs={nowMs} onOpenChat={openChat} />
            ))
          )}
        </div>

        {/* create-new */}
        <div
          ref={formRef}
          className="mt-3 space-y-2.5 rounded-xl border border-zinc-800 bg-[#1d1d20] p-3"
        >
          <div className="flex items-center justify-between">
            <p className="text-[12px] font-medium text-zinc-300">Schedule a ritual</p>
            <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-zinc-400">
              <Globe className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
              Grounded with web search
              <Switch
                checked={search}
                onCheckedChange={setSearch}
                aria-label="Ground this ritual with web search"
              />
            </label>
          </div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value.slice(0, RITUAL_MAX_TITLE_CHARS))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            aria-label="Ritual title"
            placeholder={full ? "Ritual cap reached — remove one first." : "Morning AI brief"}
            disabled={full}
            className="w-full rounded-lg border border-zinc-700/70 bg-[#18181b] px-2.5 py-1.5 text-[13px] font-medium text-zinc-100 outline-none placeholder:text-zinc-600 focus-visible:border-amber-400/40 disabled:cursor-not-allowed"
          />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value.slice(0, RITUAL_MAX_PROMPT_CHARS))}
            rows={3}
            aria-label="Ritual prompt"
            placeholder="What should Senku do at that time? Be specific — it runs unattended."
            disabled={full}
            className="w-full resize-none rounded-lg border border-zinc-700/70 bg-[#18181b] px-2.5 py-1.5 text-[12.5px] leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-600 focus-visible:border-amber-400/40 disabled:cursor-not-allowed"
          />
          <ScheduleEditor draft={sched} onChange={setSched} />
          <div className="flex items-center justify-between">
            <span className="text-[10.5px] tabular-nums text-zinc-600">
              {prompt.length}/{RITUAL_MAX_PROMPT_CHARS}
            </span>
            <button
              onClick={() => void submit()}
              disabled={!title.trim() || !prompt.trim() || creating || full}
              className="flex h-7 items-center gap-1.5 rounded-lg bg-amber-400/90 px-3 text-[12px] font-medium text-black transition-colors hover:bg-amber-300 disabled:opacity-40"
            >
              {creating ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <CalendarPlus className="h-3 w-3" />
              )}
              Schedule ritual
            </button>
          </div>
        </div>

        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-zinc-600">
          <X className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          Runs fire server-side on the gateway&apos;s clock ({USER_TIMEZONE_LABEL})
          — the app doesn&apos;t need to be open. Reply inside a ritual&apos;s chat
          and later runs remember the context.
        </p>
      </DialogContent>
    </Dialog>
  );
}
