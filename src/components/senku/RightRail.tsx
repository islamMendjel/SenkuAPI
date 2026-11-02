"use client";

// SenkuAPI — right icon rail (matches the reference screenshots).

import {
  BookOpen,
  CreditCard,
  Music,
  Pin,
  Plus,
  Settings,
  Video,
} from "lucide-react";
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
  return (
    <aside
      className="hidden w-12 shrink-0 flex-col items-center gap-1 border-l border-zinc-800/60 py-3 lg:flex"
      aria-label="Tools"
    >
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
