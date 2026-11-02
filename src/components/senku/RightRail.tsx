"use client";

// SenkuAPI — right icon rail (matches the reference screenshots).
// Run 17: the rail's CANVAS button activates the Senku Canvas —
// the Tools aside that previews code blocks in a sandboxed panel.

import {
  BookOpen,
  CreditCard,
  Music,
  PanelRight,
  Pin,
  Plus,
  Settings,
  Video,
} from "lucide-react";
import { useSenku } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";

const TOOLS = [
  { icon: Pin, label: "Pinned" },
  { icon: Video, label: "Video" },
  { icon: CreditCard, label: "Billing" },
  { icon: BookOpen, label: "Library" },
  { icon: Music, label: "Music" },
  { icon: Plus, label: "Add tool" },
];

export function RightRail({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { toast } = useToast();
  const canvasOpen = useSenku((s) => s.canvasOpen);
  const setCanvasOpen = useSenku((s) => s.setCanvasOpen);
  const hasSource = useSenku((s) => s.canvasSource != null);

  return (
    <aside
      className="hidden w-12 shrink-0 flex-col items-center gap-1 border-l border-zinc-800/60 py-3 lg:flex"
      aria-label="Tools"
    >
      {/* Senku Canvas — the one rail tool that is REAL: previews
          code blocks in a sandboxed split panel. */}
      <button
        title={
          hasSource
            ? "Senku Canvas — sandboxed code preview"
            : "Senku Canvas — opens when you preview a code block"
        }
        aria-label="Toggle Senku Canvas"
        aria-pressed={canvasOpen}
        onClick={() => setCanvasOpen(!canvasOpen)}
        className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
          canvasOpen
            ? "bg-amber-300/15 text-amber-200"
            : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
        }`}
      >
        <PanelRight className="h-4 w-4" />
      </button>

      <div className="my-1 h-px w-6 bg-zinc-800" aria-hidden />

      {TOOLS.map(({ icon: Icon, label }) => (
        <button
          key={label}
          title={label}
          aria-label={label}
          onClick={() =>
            toast({ description: `${label} — coming soon to SenkuAPI.` })
          }
          className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
        >
          <Icon className="h-4 w-4" />
        </button>
      ))}
      <button
        title="Settings"
        aria-label="Settings"
        onClick={onOpenSettings}
        className="mt-auto flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
      >
        <Settings className="h-4 w-4" />
      </button>
    </aside>
  );
}
