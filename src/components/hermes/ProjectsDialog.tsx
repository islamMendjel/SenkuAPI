"use client";

// Hermes — Projects dialog (Run 37): the editor for a project —
// a folder for chats WITH its own instructions. Creating a project
// from here can also immediately arm it as the draft for the next
// new chat ("Start a chat in it" switch), because a project with
// no chats is a folder nobody opens twice.
//
// Sibling of the Memory/Rituals dialogs: honest caps, live char
// counters, one field error surface, and instructions that tell
// the user exactly what they become (a system-prompt block the
// gateway injects into every turn of every chat in the project —
// the same contract as Memory, scoped to the folder).

import { useEffect, useRef, useState } from "react";
import { FolderInput, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useHermes, type ProjectItem } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import {
  PROJECT_INSTRUCTIONS_MAX,
  PROJECT_NAME_MAX,
} from "@/lib/hermes/constants";

export function ProjectsDialog({
  open,
  onOpenChange,
  /** null → create mode; a project → edit mode. */
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: ProjectItem | null;
}) {
  const { createProject, updateProject, newChat } = useHermes();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [startChat, setStartChat] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Fresh form every time the dialog opens (render-time adjustment
  // keyed on the open flag — the MemoryDialog/RitualsDialog pattern;
  // never setState inside an effect). Edit mode pre-fills from the row.
  const [wasOpen, setWasOpen] = useState(false);
  if (open && !wasOpen) {
    setWasOpen(true);
    setError(null);
    setBusy(false);
    setStartChat(false);
    setName(editing?.name ?? "");
    setInstructions(editing?.instructions ?? "");
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  // DOM side effect only: focus the name field once the dialog is
  // actually on screen.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => nameRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, [open]);

  const nameLeft = PROJECT_NAME_MAX - name.length;
  const instrLeft = PROJECT_INSTRUCTIONS_MAX - instructions.length;
  const canSave =
    !busy && name.trim().length > 0 && name.length <= PROJECT_NAME_MAX;

  const submit = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    if (editing) {
      const result = await updateProject(editing.id, {
        name: name.trim(),
        instructions,
      });
      if (!result.ok) {
        setError(result.error ?? "Save failed.");
        setBusy(false);
        return;
      }
      toast({ description: `Project “${name.trim()}” saved.` });
      onOpenChange(false);
      return;
    }
    const result = await createProject(name.trim(), instructions);
    if (!result.ok) {
      setError(result.error ?? "Create failed.");
      setBusy(false);
      return;
    }
    // Create mode: optionally arm the newborn project as the draft
    // and drop the user straight into a chat inside it.
    if (startChat && result.id) {
      newChat(result.id);
      toast({
        description: `Project “${name.trim()}” created — you're writing in it now.`,
      });
    } else {
      toast({ description: `Project “${name.trim()}” created.` });
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] gap-0 border-zinc-800 bg-[#1b1b1c] p-0 text-zinc-200 sm:max-w-lg">
        <DialogHeader className="space-y-1.5 border-b border-zinc-800/80 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold text-white">
            <FolderInput className="h-4 w-4 text-amber-300" />
            {editing ? "Edit project" : "New project"}
          </DialogTitle>
          <DialogDescription className="text-left text-[13px] leading-relaxed text-zinc-400">
            {editing
              ? "Instructions apply to every turn of every chat in this project."
              : "A folder for chats — with instructions that steer every answer inside it."}
          </DialogDescription>
        </DialogHeader>

        <div className="hermes-scroll max-h-[62vh] space-y-4 overflow-y-auto px-5 py-4">
          {/* Name */}
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <label
                htmlFor="project-name"
                className="text-[12.5px] font-medium text-zinc-300"
              >
                Name
              </label>
              <span
                className={`text-[11px] tabular-nums ${
                  nameLeft < 0 ? "text-red-400" : "text-zinc-500"
                }`}
              >
                {nameLeft} left
              </span>
            </div>
            <Input
              id="project-name"
              ref={nameRef}
              value={name}
              maxLength={PROJECT_NAME_MAX + 10}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="e.g. Thesis, Job hunt, Rust learning"
              className="h-9 border-zinc-700/80 bg-[#141416] text-[13.5px] text-zinc-200 placeholder:text-zinc-600 focus-visible:ring-zinc-600"
            />
          </div>

          {/* Instructions */}
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <label
                htmlFor="project-instructions"
                className="text-[12.5px] font-medium text-zinc-300"
              >
                Instructions{" "}
                <span className="font-normal text-zinc-500">(optional)</span>
              </label>
              <span
                className={`text-[11px] tabular-nums ${
                  instrLeft < 0 ? "text-red-400" : "text-zinc-500"
                }`}
              >
                {instrLeft.toLocaleString()} left
              </span>
            </div>
            <Textarea
              id="project-instructions"
              value={instructions}
              maxLength={PROJECT_INSTRUCTIONS_MAX + 100}
              onChange={(e) => setInstructions(e.target.value)}
              rows={6}
              placeholder={
                "e.g. You are helping me draft my physics thesis.\n- Answer in formal academic English\n- Always show derivations step by step\n- Flag claims that need a citation"
              }
              className="min-h-[120px] resize-y border-zinc-700/80 bg-[#141416] text-[13px] leading-relaxed text-zinc-200 placeholder:text-zinc-600 focus-visible:ring-zinc-600"
            />
            <p className="text-[11.5px] leading-relaxed text-zinc-500">
              Injected into every answer in this project&apos;s chats — like{" "}
              <span className="text-zinc-400">Memory</span>, but scoped to the
              folder. Editing them re-answers nothing retroactively; new turns
              follow immediately.
            </p>
          </div>

          {/* Create → jump straight in */}
          {!editing && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-[#141416] px-3.5 py-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-zinc-200">
                  Start a chat in it now
                </p>
                <p className="text-[11.5px] text-zinc-500">
                  Arms this project for the next message you send.
                </p>
              </div>
              <Switch
                checked={startChat}
                onCheckedChange={setStartChat}
                aria-label="Start a chat in this project now"
              />
            </div>
          )}

          {error && (
            <p className="rounded-md bg-red-500/10 px-3 py-2 text-[12.5px] text-red-300">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="flex-row items-center justify-end gap-2 border-t border-zinc-800/80 px-5 py-3.5">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="h-8 px-3 text-[13px] text-zinc-400 hover:text-zinc-200"
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!canSave}
            className="h-8 gap-1.5 bg-amber-400 px-4 text-[13px] font-medium text-zinc-950 hover:bg-amber-300 disabled:opacity-40"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {editing ? "Save changes" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
