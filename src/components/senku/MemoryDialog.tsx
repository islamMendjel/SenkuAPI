"use client";

// SenkuAPI — Memory dialog (Run 28).
//
// The management surface for the gateway's persistent personal
// memory: what SenkuAPI always remembers about its owner. Every
// entry is injected into every system prompt (normal, search and
// duel turns) — this dialog is the single place to add, edit and
// forget. Honest by design: the count is real, the limit is real
// (50 entries, 500 chars), empty state teaches with one-click
// examples, and every action toasts its real outcome.

import { useEffect, useRef, useState } from "react";
import {
  Brain,
  Check,
  Loader2,
  Pencil,
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
import { useSenku, type MemoryItem } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { MEMORY_MAX_CHARS, MEMORY_MAX_ENTRIES } from "@/lib/senku/constants";

/** One memory row: read view ⇄ inline edit, delete, dirty-aware. */
function MemoryRow({ entry }: { entry: MemoryItem }) {
  const { updateMemory, deleteMemory } = useSenku();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.content);
  const [saving, setSaving] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Draft follows the store's content until the user starts editing
  // — the render-time prop-adjustment pattern (no effect, no
  // cascading render; official React way to derive from props).
  const [syncedContent, setSyncedContent] = useState(entry.content);
  if (syncedContent !== entry.content) {
    setSyncedContent(entry.content);
    if (!editing) setDraft(entry.content);
  }

  useEffect(() => {
    if (editing) {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(draft.length, draft.length);
    }
  }, [editing]);

  const dirty = draft.trim() !== entry.content;

  const save = async () => {
    if (!dirty || saving) return;
    const t = draft.trim();
    if (!t) {
      toast({ variant: "destructive", description: "Memory can't be empty — delete it instead." });
      return;
    }
    setSaving(true);
    const ok = await updateMemory(entry.id, t);
    setSaving(false);
    if (ok) {
      setEditing(false);
      toast({ description: "Memory updated — every new answer already uses it." });
    } else {
      toast({ variant: "destructive", description: "Could not update that memory." });
    }
  };

  const remove = async () => {
    const ok = await deleteMemory(entry.id);
    toast(
      ok
        ? { description: "Forgotten. New answers stop using it immediately." }
        : { variant: "destructive", description: "Could not delete that memory." }
    );
  };

  if (editing) {
    return (
      <div className="rounded-xl border border-amber-400/25 bg-[#26251f] p-2.5">
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, MEMORY_MAX_CHARS))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void save();
            }
            if (e.key === "Escape") {
              setDraft(entry.content);
              setEditing(false);
            }
          }}
          rows={Math.min(4, Math.max(2, Math.ceil(draft.length / 46)))}
          className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600"
          placeholder="What should SenkuAPI remember?"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[10.5px] tabular-nums text-zinc-600">
            {draft.length}/{MEMORY_MAX_CHARS}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => {
                setDraft(entry.content);
                setEditing(false);
              }}
              className="flex h-7 items-center gap-1 rounded-lg px-2.5 text-[12px] text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
            >
              <RotateCcw className="h-3 w-3" /> Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="flex h-7 items-center gap-1 rounded-lg bg-emerald-500/90 px-2.5 text-[12px] font-medium text-black transition-colors hover:bg-emerald-400 disabled:opacity-40"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Save
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-2 rounded-xl border border-zinc-800 bg-[#1d1d20] p-2.5 transition-colors hover:border-zinc-700">
      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-zinc-200">
        {entry.content}
      </p>
      <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
        <button
          onClick={() => setEditing(true)}
          aria-label="Edit memory"
          title="Edit"
          className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          onClick={() => void remove()}
          aria-label="Forget this"
          title="Forget"
          className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-red-500/15 hover:text-red-300"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

const EXAMPLES = [
  "I'm a TypeScript developer — always answer in TypeScript.",
  "Keep answers short and direct. No filler.",
  "I'm in Algiers (Africa/Algiers) — use my timezone for examples.",
];

export function MemoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { memories, addMemory } = useSenku();
  const { toast } = useToast();
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLTextAreaElement | null>(null);

  // The add-field starts fresh every time the dialog opens —
  // render-time adjustment keyed on the open flag (no effect).
  const [wasOpen, setWasOpen] = useState(false);
  if (open && !wasOpen) {
    setWasOpen(true);
    setDraft("");
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  const submit = async (text?: string) => {
    const content = (text ?? draft).trim();
    if (!content || adding) return;
    setAdding(true);
    const ok = await addMemory(content);
    setAdding(false);
    if (ok) {
      setDraft("");
      toast({ description: "Remembered. Every answer from now on uses it." });
    } else {
      toast({
        variant: "destructive",
        description: "Could not save that memory — try again.",
      });
    }
  };

  const full = memories.length >= MEMORY_MAX_ENTRIES;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto rounded-2xl border-zinc-800 bg-[#212121] p-5 text-zinc-200">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold text-white">
            <Brain className="h-4 w-4 text-amber-300" aria-hidden />
            Memory
            <span className="ml-auto text-[11.5px] font-normal tabular-nums text-zinc-500">
              {memories.length}/{MEMORY_MAX_ENTRIES}
            </span>
          </DialogTitle>
          <DialogDescription className="text-[12.5px] leading-snug text-zinc-500">
            What SenkuAPI always remembers about you — durable facts and
            preferences, injected into every conversation from now on.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 pt-1">
          {memories.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-700/80 p-4">
              <p className="text-[13px] leading-relaxed text-zinc-400">
                Nothing remembered yet. Tell the gateway who you are and how
                you like your answers:
              </p>
              <div className="mt-3 space-y-1.5">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => void submit(ex)}
                    disabled={adding}
                    className="group flex w-full items-center gap-2 rounded-lg border border-zinc-800 bg-[#1d1d20] px-3 py-2 text-left text-[12.5px] text-zinc-300 transition-colors hover:border-amber-400/35 hover:text-zinc-100 disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-colors group-hover:text-amber-300" />
                    <span className="min-w-0">{ex}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            memories.map((m) => <MemoryRow key={m.id} entry={m} />)
          )}
        </div>

        {/* add-new */}
        <div className="mt-3 rounded-xl border border-zinc-800 bg-[#1d1d20] p-2.5">
          <textarea
            ref={addRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, MEMORY_MAX_CHARS))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={2}
            placeholder={full ? "Memory is full — remove an entry first." : "Remember that…"}
            disabled={full}
            className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600 disabled:cursor-not-allowed"
          />
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-[10.5px] tabular-nums text-zinc-600">
              {draft.length}/{MEMORY_MAX_CHARS}
            </span>
            <button
              onClick={() => void submit()}
              disabled={!draft.trim() || adding || full}
              className="flex h-7 items-center gap-1.5 rounded-lg bg-amber-400/90 px-3 text-[12px] font-medium text-black transition-colors hover:bg-amber-300 disabled:opacity-40"
            >
              {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Brain className="h-3 w-3" />}
              Remember
            </button>
          </div>
        </div>

        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-zinc-600">
          <X className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          Memories live in your local gateway database and shape every new
          answer. Editing or forgetting takes effect on the next message.
        </p>
      </DialogContent>
    </Dialog>
  );
}
