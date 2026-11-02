"use client";

// SenkuAPI — left sidebar: brand row, new chat,
// Projects/Recent accordions, user card + settings popover.
// (The old provider/tokens pill was removed — usage lives in the
// top-bar token pill + limiter dialog instead.)
//
// Run 13: always mounted — the app shell (SenkuApp) owns the
// open/close animation and hover-peek lifecycle; this component
// just renders the panel at its fixed 264px width.
//
// Run 15: every chat row gets a 3-dot action menu — Rename (inline,
// no page refresh), Export as Markdown / JSON (clean download), and
// Delete (SQLite wipe). The menu reveals on hover/focus, exactly
// like the old trash button, but with all three actions.

import { useMemo, useRef, useState } from "react";
import Image from "next/image";
import {
  ChevronRight,
  CircleHelp,
  FileJson,
  FileText,
  Folder,
  Images,
  Languages,
  LogOut,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import { useSenku, type ChatListItem } from "@/lib/store";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import {
  chatToMarkdown,
  downloadText,
  safeFilename,
  type ExportMessage,
} from "@/lib/senku/export";

export function Sidebar({
  onManageProviders,
  onCollapse,
}: {
  onManageProviders: () => void;
  onCollapse: () => void;
}) {
  const {
    user,
    chats,
    currentChatId,
    messages,
    temporary,
    searchOpen,
    searchFilter,
    setSearchOpen,
    setSearchFilter,
    newChat,
    selectChat,
    deleteChat,
    renameChat,
    // Run 23 — the Images row: gallery view + live forged count.
    galleryOpen,
    imageCount,
    openGallery,
    closeGallery,
    setSidebarOpen,
  } = useSenku();
  const { toast } = useToast();

  const [projectsOpen, setProjectsOpen] = useState(true);
  const [recentOpen, setRecentOpen] = useState(true);

  // Run 25 — on phones the sidebar is a modal drawer (backdrop
  // md:hidden): any navigation — new chat, open chat, open gallery —
  // must step the drawer aside, the way every mobile chat app does.
  // On desktop the panel is PINNED: clicking around must never
  // collapse it. The md breakpoint (768px) matches the backdrop's.
  const closeDrawerOnMobile = () => {
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) {
      onCollapse();
    }
  };

  // ── Inline rename (Run 15) ──
  // `renamingId` swaps one row's title button for an input; the ref
  // guards against double-commit when Enter/Escape unmount the
  // input and the browser still fires a final blur.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameDone = useRef(false);

  const startRename = (chat: ChatListItem) => {
    renameDone.current = false;
    setRenamingId(chat.id);
    setRenameValue(chat.title);
  };
  const commitRename = async (id: string, title: string) => {
    setRenamingId(null);
    const t = title.trim();
    if (!t) return;
    const ok = await renameChat(id, t);
    if (!ok) {
      toast({
        variant: "destructive",
        description: "Rename failed — the title was restored.",
      });
    }
  };

  // ── Export (Run 15) ──
  // The open chat exports straight from the live store; any other
  // chat is fetched once from the API, then rendered to .md / .json
  // and handed to the browser as a download.
  const exportChat = async (chat: ChatListItem, fmt: "md" | "json") => {
    try {
      let msgs: ExportMessage[];
      let model = chat.model;
      let provider = chat.provider;
      let createdAt = chat.createdAt;
      if (chat.id === currentChatId && !temporary && messages.length > 0) {
        msgs = messages.map((m) => ({
          role: m.role,
          content: m.content,
          model: m.model ?? null,
          provider: m.provider ?? null,
          keyLabel: m.keyLabel ?? null,
          tokens: m.tokens ?? null,
          cached: m.cached ?? null,
          servedBy: m.servedBy ?? null,
          createdAt: m.createdAt ?? null,
          sources: m.sources ?? null,
          attachments: m.attachments ?? null,
          // Run 22 — forged images export as markdown image links.
          image: m.image ?? null,
        }));
      } else {
        const res = await fetch(`/api/chats/${chat.id}`);
        if (!res.ok) throw new Error("fetch failed");
        const data = await res.json();
        msgs = (data.messages ?? []) as ExportMessage[];
        model = data.model ?? model;
        provider = data.provider ?? provider;
        createdAt = data.createdAt ?? createdAt;
      }
      const base = safeFilename(chat.title);
      if (fmt === "md") {
        downloadText(
          `${base}.md`,
          chatToMarkdown(chat.title, msgs, { model, provider, createdAt }),
          "text/markdown;charset=utf-8"
        );
      } else {
        downloadText(
          `${base}.json`,
          JSON.stringify(
            {
              title: chat.title,
              model,
              provider,
              createdAt,
              exportedAt: new Date().toISOString(),
              messages: msgs,
            },
            null,
            2
          ),
          "application/json;charset=utf-8"
        );
      }
      toast({
        description: `Exported “${chat.title}” as ${
          fmt === "md" ? "Markdown" : "JSON"
        }.`,
      });
    } catch {
      toast({
        variant: "destructive",
        description: "Export failed — could not load this chat.",
      });
    }
  };

  /** Run 23 — open/close the image Gallery. On phones the sidebar
   *  is a screen-covering overlay, so it steps aside the moment the
   *  gallery opens (desktop keeps its pinned layout). */
  const toggleGallery = () => {
    if (galleryOpen) {
      closeGallery();
      return;
    }
    openGallery();
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches
    ) {
      setSidebarOpen(false);
    }
  };

  const filteredChats = useMemo(() => {
    const f = searchFilter.trim().toLowerCase();
    return f ? chats.filter((c) => c.title.toLowerCase().includes(f)) : chats;
  }, [chats, searchFilter]);

  return (
    <aside
      className="flex h-full w-[264px] shrink-0 flex-col bg-[#212121]"
      aria-label="Sidebar"
    >
      {/* Brand row */}
      <div className="flex h-12 items-center gap-2 px-3">
        <Image
          src="/senku-sparkle.png"
          alt="SenkuAPI logo"
          width={26}
          height={26}
          className="h-[26px] w-[26px] shrink-0"
          priority
        />
        <span className="truncate text-[15px] font-semibold text-white">
          SenkuAPI
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            aria-label="Search chats"
            title="Search chats"
            onClick={() => setSearchOpen(!searchOpen)}
            className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
              searchOpen
                ? "bg-white/10 text-white"
                : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
            }`}
          >
            <Search className="h-4 w-4" />
          </button>
          <button
            aria-label="Toggle sidebar"
            title="Toggle sidebar"
            onClick={onCollapse}
            className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* New chat */}
      <button
        onClick={() => {
          closeDrawerOnMobile();
          newChat();
        }}
        className="mx-3 mt-3 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-zinc-200 transition-colors hover:bg-white/5"
      >
        <Pencil className="h-4 w-4 text-zinc-400" />
        New chat
      </button>

      {/* Run 23 — image history, the way chats have history. The
          count badge is the honest gallery size (disk-verified). */}
      <button
        onClick={() => {
          closeDrawerOnMobile();
          toggleGallery();
        }}
        aria-current={galleryOpen ? "page" : undefined}
        className={`mx-3 mt-1.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
          galleryOpen
            ? "bg-white/10 text-white"
            : "text-zinc-200 hover:bg-white/5"
        }`}
      >
        <Images
          className={`h-4 w-4 ${galleryOpen ? "text-amber-300" : "text-zinc-400"}`}
        />
        Images
        {imageCount > 0 && (
          <span
            className="ml-auto rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-zinc-400"
            title={`${imageCount} forged image${imageCount === 1 ? "" : "s"} across all chats`}
          >
            {imageCount}
          </span>
        )}
      </button>

      {/* Search input (toggled by the brand-row search icon) */}
      {searchOpen && (
        <div className="px-3 pt-2">
          <Input
            autoFocus
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            placeholder="Search recent chats…"
            className="h-8 border-zinc-700/80 bg-[#18181b] text-[13px] text-zinc-200 placeholder:text-zinc-500 focus-visible:ring-zinc-600"
          />
        </div>
      )}

      {/* Accordions */}
      <nav className="senku-scroll mt-3 flex-1 overflow-y-auto pb-2">
        {/* Projects */}
        <div>
          <button
            onClick={() => setProjectsOpen(!projectsOpen)}
            className="flex w-full items-center gap-1.5 px-4 py-1.5 text-[13px] font-medium text-zinc-300 transition-colors hover:text-white"
            aria-expanded={projectsOpen}
          >
            <ChevronRight
              className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${
                projectsOpen ? "rotate-90" : ""
              }`}
            />
            Projects
          </button>
          {projectsOpen && (
            <div className="flex items-center gap-2 px-4 py-1.5 pl-[26px]">
              <Folder className="h-3.5 w-3.5 text-zinc-600" />
              <span className="text-[13px] italic text-zinc-500">
                No projects
              </span>
            </div>
          )}
        </div>

        {/* Recent */}
        <div className="mt-1">
          <button
            onClick={() => setRecentOpen(!recentOpen)}
            className="flex w-full items-center gap-1.5 px-4 py-1.5 text-[13px] font-medium text-zinc-300 transition-colors hover:text-white"
            aria-expanded={recentOpen}
          >
            <ChevronRight
              className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${
                recentOpen ? "rotate-90" : ""
              }`}
            />
            Recent
          </button>
          {recentOpen && (
            <div className="mt-0.5 px-2">
              {filteredChats.length === 0 ? (
                <p className="px-2 py-1.5 text-[13px] italic text-zinc-500">
                  {searchFilter ? "No matches" : "No chats yet"}
                </p>
              ) : (
                filteredChats.map((chat) =>
                  renamingId === chat.id ? (
                    <div
                      key={chat.id}
                      className="flex items-center rounded-lg bg-white/10 px-1.5 py-1"
                    >
                      <Input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            renameDone.current = true;
                            void commitRename(chat.id, renameValue);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            renameDone.current = true;
                            setRenamingId(null);
                          }
                        }}
                        onBlur={() => {
                          if (renameDone.current) return;
                          renameDone.current = true;
                          void commitRename(chat.id, renameValue);
                        }}
                        aria-label="Rename chat"
                        className="h-7 border-zinc-700/80 bg-[#18181b] text-[13px] text-zinc-200 focus-visible:ring-zinc-600"
                      />
                    </div>
                  ) : (
                    <div
                      key={chat.id}
                      className={`group flex items-center rounded-lg transition-colors ${
                        currentChatId === chat.id && !temporary
                          ? "bg-white/10"
                          : "hover:bg-white/5"
                      }`}
                    >
                      <button
                        onClick={() => {
                          closeDrawerOnMobile();
                          void selectChat(chat.id);
                        }}
                        className="min-w-0 flex-1 truncate px-2.5 py-2 text-left text-[13px] text-zinc-300 group-hover:text-zinc-100"
                        title={chat.title}
                      >
                        {chat.title}
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            aria-label={`Chat actions: ${chat.title}`}
                            title="Chat actions"
                            className="mr-1 hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200 group-hover:flex group-focus-within:flex data-[state=open]:flex [@media(hover:none)]:flex"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          side="right"
                          align="end"
                          className="w-48 border-zinc-800 bg-[#262627] text-zinc-200"
                        >
                          <DropdownMenuLabel className="truncate text-[11px] tracking-wide text-zinc-500">
                            {chat.title}
                          </DropdownMenuLabel>
                          <DropdownMenuSeparator className="bg-zinc-800" />
                          <DropdownMenuItem
                            className="gap-2.5 py-2 text-[13px]"
                            onClick={() => startRename(chat)}
                          >
                            <Pencil className="h-4 w-4 text-zinc-400" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="gap-2.5 py-2 text-[13px]"
                            onClick={() => void exportChat(chat, "md")}
                          >
                            <FileText className="h-4 w-4 text-zinc-400" />
                            Export as Markdown
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="gap-2.5 py-2 text-[13px]"
                            onClick={() => void exportChat(chat, "json")}
                          >
                            <FileJson className="h-4 w-4 text-zinc-400" />
                            Export as JSON
                          </DropdownMenuItem>
                          <DropdownMenuSeparator className="bg-zinc-800" />
                          <DropdownMenuItem
                            className="gap-2.5 py-2 text-[13px] text-red-400 focus:bg-red-500/10 focus:text-red-300"
                            onClick={() => void deleteChat(chat.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )
                )
              )}
            </div>
          )}
        </div>
      </nav>

      {/* User card + settings popover */}
      <div className="border-t border-zinc-800/80 p-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#7c5cff] to-[#4aa8ff] text-[13px] font-semibold text-white">
            {user.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px] text-zinc-200">{user.email}</p>
            <p className="truncate text-[11px] text-zinc-500">{user.plan}</p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label="Open settings menu"
                suppressHydrationWarning
                className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-200"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="start"
              className="w-56 border-zinc-800 bg-[#262627] text-zinc-200"
            >
              <DropdownMenuLabel className="text-[11px] tracking-wide text-zinc-500">
                {user.email}
              </DropdownMenuLabel>
              <DropdownMenuSeparator className="bg-zinc-800" />
              <DropdownMenuItem
                className="gap-2.5 py-2 text-[13px]"
                onClick={onManageProviders}
              >
                <Settings className="h-4 w-4 text-zinc-400" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2.5 py-2 text-[13px]"
                onClick={() =>
                  toast({ description: "Language is set to English." })
                }
              >
                <Languages className="h-4 w-4 text-zinc-400" />
                Language
                <span className="ml-auto text-xs text-zinc-500">English</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2.5 py-2 text-[13px]"
                onClick={() =>
                  toast({
                    description:
                      "Docs: point any OpenAI-compatible client at /api/v1/chat/completions.",
                  })
                }
              >
                <CircleHelp className="h-4 w-4 text-zinc-400" />
                Get help
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2.5 py-2 text-[13px]"
                onClick={() =>
                  toast({
                    description:
                      "Single-user personal gateway — session stays active.",
                  })
                }
              >
                <LogOut className="h-4 w-4 text-zinc-400" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </aside>
  );
}
