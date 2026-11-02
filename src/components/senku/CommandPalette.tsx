"use client";

// SenkuAPI — ⌘K command palette (the power-user launcher).
// Fuzzy search across actions, models, providers and recent chats.
// ↑/↓ navigate · ↵ run · esc close. Open with ⌘K / Ctrl+K anywhere.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Brain,
  Clock,
  Gauge,
  Globe,
  MessageSquare,
  Pencil,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Swords,
  Zap,
} from "lucide-react";
import { useSenku } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { modelHint, modelMeta } from "@/lib/senku/models";

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  keywords?: string;
  active?: boolean;
  run: () => void | Promise<void>;
}

/** Subsequence fuzzy match with contiguous-run bonus. */
function fuzzyScore(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      streak++;
      score += 1 + streak * 1.5 + (ti === 0 || t[ti - 1] === " " ? 3 : 0);
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : -1;
}

export function CommandPalette({
  onOpenChange,
  onOpenLimiter,
  onManageProviders,
}: {
  onOpenChange: (v: boolean) => void;
  onOpenLimiter: () => void;
  onManageProviders: () => void;
}) {
  const {
    chats,
    models,
    model,
    setModel,
    providers,
    switchProvider,
    searchEnabled,
    toggleSearch,
    duelEnabled,
    toggleDuel,
    effort,
    setEffort,
    temporary,
    toggleTemporary,
    newChat,
    selectChat,
    syncModels,
  } = useSenku();
  const { toast } = useToast();

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // The palette is mounted fresh on every open (parent renders it
  // conditionally), so state starts clean — no reset logic needed.

  const close = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  // focus the input on mount (DOM side effect only)
  useEffect(() => {
    const t = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, []);

  const items: PaletteItem[] = useMemo(() => {
    const list: PaletteItem[] = [
      {
        id: "act-new-chat",
        group: "Actions",
        label: "New chat",
        hint: "↵",
        icon: <Pencil className="h-4 w-4" />,
        keywords: "new chat start conversation",
        run: () => newChat(),
      },
      {
        id: "act-search",
        group: "Actions",
        label: searchEnabled ? "Disable web search" : "Enable web search",
        hint: searchEnabled ? "On" : "Off",
        icon: <Globe className="h-4 w-4" />,
        keywords: "web search internet browse",
        active: searchEnabled,
        run: () => {
          toggleSearch();
          toast({
            description: searchEnabled
              ? "Web search disabled."
              : "Web search enabled — max 3 snippets per turn.",
          });
        },
      },
      {
        id: "act-duel",
        group: "Actions",
        label: duelEnabled ? "Disable model duel" : "Enable model duel",
        hint: duelEnabled ? "On" : "Off",
        icon: <Swords className="h-4 w-4" />,
        keywords: "duel compare models race versus battle",
        active: duelEnabled,
        run: () => {
          toggleDuel();
          toast({
            description: duelEnabled
              ? "Duel disabled."
              : "Duel armed — next message races two models; you pick the keeper.",
          });
        },
      },
      ...([
        {
          level: "fast" as const,
          label: "Effort: Fast",
          icon: <Zap className="h-4 w-4" />,
          desc: "Fastest engine in the pool · brief answers",
        },
        {
          level: "medium" as const,
          label: "Effort: Medium",
          icon: <Sparkles className="h-4 w-4" />,
          desc: "Your selected model · balanced",
        },
        {
          level: "deep" as const,
          label: "Effort: Deep",
          icon: <Brain className="h-4 w-4" />,
          desc: "Strongest engine · thinking · deep research with Search",
        },
      ].map(({ level, label, icon, desc }) => ({
        id: `act-effort-${level}`,
        group: "Actions",
        label,
        hint: effort === level ? "Active" : undefined,
        icon,
        keywords: `effort speed fast medium deep thinking research reasoning quality ${level}`,
        active: effort === level,
        run: () => {
          setEffort(level);
          toast({ description: `Effort set to ${level} — ${desc}.` });
        },
      }))),
      {
        id: "act-temp",
        group: "Actions",
        label: temporary ? "Disable temporary chat" : "Enable temporary chat",
        hint: temporary ? "On" : "Off",
        icon: <Clock className="h-4 w-4" />,
        keywords: "temporary ephemeral history privacy",
        active: temporary,
        run: () => toggleTemporary(),
      },
      {
        id: "act-limiter",
        group: "Actions",
        label: "Token limiter status",
        hint: "3 tiers",
        icon: <Gauge className="h-4 w-4" />,
        keywords: "tokens usage limits pool tier",
        run: () => onOpenLimiter(),
      },
      {
        id: "act-providers",
        group: "Actions",
        label: "Manage providers & keys",
        hint: "keys",
        icon: <Settings className="h-4 w-4" />,
        keywords: "providers keys settings oxionai apinex",
        run: () => onManageProviders(),
      },
      {
        id: "act-sync",
        group: "Actions",
        label: "Sync model list from provider",
        hint: "↻",
        icon: <RefreshCw className="h-4 w-4" />,
        keywords: "sync models refresh provider",
        run: async () => {
          const ok = await syncModels();
          toast({
            description: ok
              ? "Model list synced from provider."
              : "Provider sync unavailable — using cached list.",
          });
        },
      },
    ];

    for (const m of models.slice(0, 12)) {
      const meta = modelMeta(m);
      list.push({
        id: `model-${m}`,
        group: "Switch model",
        label: meta.name,
        hint: m === model ? "Active" : modelHint(meta) || undefined,
        icon: <Sparkles className="h-4 w-4" />,
        keywords: `model ${m}`,
        active: m === model,
        run: () => setModel(m),
      });
    }

    for (const p of providers) {
      list.push({
        id: `prov-${p.id}`,
        group: "Switch provider",
        label: p.name,
        hint: p.isActive ? "Active" : p.hasTokenLimit ? "limited" : "unlimited",
        icon: (
          <span
            className={`h-2 w-2 rounded-full ${
              p.isActive ? "bg-emerald-400 senku-pulse" : "bg-zinc-600"
            }`}
          />
        ),
        keywords: `provider ${p.name} ${p.hasTokenLimit ? "limited" : "unlimited"}`,
        active: p.isActive,
        run: async () => {
          if (p.isActive) return;
          try {
            await switchProvider(p.id);
            toast({ description: `Switched to ${p.name}.` });
          } catch (e) {
            toast({
              description: (e as Error).message,
              variant: "destructive",
            });
          }
        },
      });
    }

    for (const c of chats.slice(0, 8)) {
      list.push({
        id: `chat-${c.id}`,
        group: "Recent chats",
        label: c.title,
        hint: c.provider,
        icon: <MessageSquare className="h-4 w-4" />,
        keywords: `chat ${c.title} ${c.provider}`,
        run: () => void selectChat(c.id),
      });
    }

    return list;
  }, [
    chats,
    models,
    model,
    providers,
    searchEnabled,
    duelEnabled,
    effort,
    setEffort,
    temporary,
    newChat,
    toggleSearch,
    toggleDuel,
    toggleTemporary,
    setModel,
    switchProvider,
    selectChat,
    syncModels,
    toast,
    onOpenLimiter,
    onManageProviders,
  ]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    return items
      .map((it) => ({
        it,
        score: Math.max(
          fuzzyScore(query, it.label),
          fuzzyScore(query, `${it.group} ${it.keywords ?? ""}`)
        ),
      }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.it);
  }, [items, query]);

  // clamped cursor — derived, never stale after filtering
  const activeIndex = filtered.length
    ? Math.min(active, filtered.length - 1)
    : 0;

  // keep the active item in view
  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const runItem = useCallback(
    async (it: PaletteItem | undefined) => {
      if (!it) return;
      close();
      await it.run();
    },
    [close]
  );
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (filtered.length ? (a + 1) % filtered.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) =>
        filtered.length ? (a - 1 + filtered.length) % filtered.length : 0
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      void runItem(filtered[activeIndex]);
    }
  };

  if (filtered.length === 0 && !query.trim()) return null;

  // group headers computed in render order
  let lastGroup = "";

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/55 px-4 pt-[16vh] backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="senku-fade-up w-full max-w-[620px] overflow-hidden rounded-2xl border border-zinc-700/80 bg-[#1d1d20] shadow-[0_24px_80px_rgba(0,0,0,0.6)]"
        onKeyDown={onKeyDown}
      >
        {/* input row */}
        <div className="flex items-center gap-3 border-b border-zinc-800 px-4">
          <Search className="h-4 w-4 shrink-0 text-zinc-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Search actions, models, providers, chats…"
            aria-label="Command palette search"
            className="h-13 w-full bg-transparent py-4 text-[15px] text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <button
            onClick={close}
            aria-label="Close command palette"
            className="shrink-0 rounded-md border border-zinc-700 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
          >
            ESC
          </button>
        </div>

        {/* results */}
        <div className="senku-scroll max-h-[46vh] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-zinc-500">
              No results for “{query.trim()}”
            </p>
          ) : (
            filtered.map((it, i) => {
              const showHeader = it.group !== lastGroup;
              lastGroup = it.group;
              return (
                <div key={it.id}>
                  {showHeader && (
                    <p className="px-3 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                      {it.group}
                    </p>
                  )}
                  <button
                    ref={(el) => {
                      itemRefs.current[i] = el;
                    }}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => void runItem(it)}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                      i === activeIndex ? "bg-white/10" : "hover:bg-white/5"
                    }`}
                  >
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${
                        i === activeIndex
                          ? "border-amber-400/30 bg-amber-400/10 text-amber-300"
                          : "border-zinc-700/70 bg-zinc-800/60 text-zinc-400"
                      }`}
                    >
                      {it.icon}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-zinc-200">
                      {it.label}
                    </span>
                    {it.active && (
                      <span className="shrink-0 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                        active
                      </span>
                    )}
                    {it.hint && !it.active && (
                      <span className="shrink-0 text-[11px] text-zinc-500">
                        {it.hint}
                      </span>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* footer hints */}
        <div className="flex items-center gap-4 border-t border-zinc-800 px-4 py-2.5 text-[11px] text-zinc-500">
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-zinc-700 bg-zinc-800/80 px-1 py-0.5 font-sans text-[10px]">↑↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-zinc-700 bg-zinc-800/80 px-1 py-0.5 font-sans text-[10px]">↵</kbd>
            select
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <kbd className="rounded border border-zinc-700 bg-zinc-800/80 px-1 py-0.5 font-sans text-[10px]">⌘K</kbd>
            toggle
          </span>
        </div>
      </div>
    </div>
  );
}
