"use client";

// Hermes — Manage Providers dialog:
// exactly ONE provider active at a time; switching sets the selected
// provider active and all others false; round-robin runs on the
// active provider's keys. Keys can be added, toggled and removed.

import { useState } from "react";
import { Check, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useHermes } from "@/lib/store";
import { formatCompact, formatFull } from "@/lib/hermes/format";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import type { ProviderView } from "@/lib/hermes/types";

function ProviderCard({
  provider,
  onSwitch,
}: {
  provider: ProviderView;
  onSwitch: (id: string) => Promise<void>;
}) {
  const { addKey, deleteKey, toggleKey } = useHermes();
  const { toast } = useToast();
  const [switching, setSwitching] = useState(false);
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [adding, setAdding] = useState(false);

  const doSwitch = async () => {
    setSwitching(true);
    try {
      await onSwitch(provider.id);
      toast({
        description: `${provider.name} is now the active provider.`,
      });
    } catch (e) {
      toast({ description: (e as Error).message, variant: "destructive" });
    } finally {
      setSwitching(false);
    }
  };

  const doAddKey = async () => {
    if (!key.trim()) return;
    setAdding(true);
    try {
      await addKey(provider.id, label.trim(), key.trim());
      setLabel("");
      setKey("");
      toast({ description: "Key added to the pool." });
    } catch (e) {
      toast({ description: (e as Error).message, variant: "destructive" });
    } finally {
      setAdding(false);
    }
  };

  return (
    <div
      className={`rounded-xl border p-3.5 transition-colors ${
        provider.isActive
          ? "border-emerald-500/40 bg-emerald-500/[0.04]"
          : "border-zinc-800 bg-[#1d1d20]"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-2 text-[14px] font-semibold text-white">
          {provider.isActive && (
            <span className="hermes-pulse h-2 w-2 rounded-full bg-emerald-400" />
          )}
          {provider.name}
        </span>
        <span className="rounded-full bg-zinc-800/80 px-2 py-0.5 text-[10.5px] font-medium text-zinc-300">
          {provider.hasTokenLimit
            ? `${formatCompact(provider.tokenLimitPerKey)} tokens / key / mo`
            : "Unlimited"}
        </span>
        <span className="rounded-full bg-zinc-800/80 px-2 py-0.5 text-[10.5px] font-medium text-zinc-300">
          ×{provider.tokenMultiplier.toFixed(1)} multiplier
        </span>
        <span className="ml-auto">
          {provider.isActive ? (
            <span className="flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 text-[12px] font-medium text-emerald-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              Active
            </span>
          ) : (
            <button
              onClick={doSwitch}
              disabled={switching}
              className="flex items-center gap-1.5 rounded-full bg-white px-3.5 py-1 text-[12px] font-medium text-black transition-colors hover:bg-zinc-200 disabled:opacity-60"
            >
              {switching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Switch
            </button>
          )}
        </span>
      </div>

      <p className="mt-1.5 truncate font-mono text-[11px] text-zinc-500">
        {provider.baseUrl ?? "no base URL"} · {provider.models.length} models ·{" "}
        {formatFull(provider.totalTokens)} lifetime tokens
      </p>

      {/* keys */}
      <div className="mt-3 space-y-1.5">
        {provider.keys.map((k) => (
          <div
            key={k.id}
            className="flex items-center gap-2.5 rounded-lg border border-zinc-800/80 bg-[#18181b] px-2.5 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[12px] text-zinc-300">
                {k.masked}
              </p>
              <p className="text-[10.5px] text-zinc-600">
                {k.label} · {formatFull(k.tokensUsedThisMonth)} tokens this month
                {k.lastUsedAt
                  ? ` · used ${new Date(k.lastUsedAt).toLocaleDateString()}`
                  : " · never used"}
              </p>
            </div>
            <Switch
              checked={k.isActive}
              onCheckedChange={(v) => void toggleKey(k.id, v)}
              aria-label={`Toggle key ${k.label}`}
            />
            <button
              onClick={() => void deleteKey(k.id)}
              aria-label={`Delete key ${k.label}`}
              className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-red-400/10 hover:text-red-400"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}

        <div className="flex gap-2">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional)"
            className="h-8 w-32 rounded-lg border-zinc-800 bg-[#18181b] text-[12px] text-zinc-200 placeholder:text-zinc-600 focus-visible:ring-zinc-600"
          />
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Paste API key…"
            className="h-8 flex-1 rounded-lg border-zinc-800 bg-[#18181b] font-mono text-[12px] text-zinc-200 placeholder:text-zinc-600 focus-visible:ring-zinc-600"
            onKeyDown={(e) => {
              if (e.key === "Enter") void doAddKey();
            }}
          />
          <button
            onClick={doAddKey}
            disabled={adding || !key.trim()}
            aria-label="Add key"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-700 text-zinc-300 transition-colors hover:bg-white/5 disabled:opacity-40"
          >
            {adding ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProvidersDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { providers, switchProvider } = useHermes();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto rounded-2xl border-zinc-800 bg-[#212121] p-5 text-zinc-200 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-semibold text-white">
            Manage Providers
          </DialogTitle>
          <DialogDescription className="text-[12.5px] leading-snug text-zinc-500">
            Exactly one provider is active at a time. Switching activates the
            selected provider and deactivates all others — round-robin key
            rotation then runs strictly on its keys.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 pt-1">
          {providers.map((p) => (
            <ProviderCard key={p.id} provider={p} onSwitch={switchProvider} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
