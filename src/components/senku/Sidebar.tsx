"use client";

// SenkuAPI — left sidebar: brand row, new chat,
// Projects/Recent accordions, user card + settings popover.
// (The old provider/tokens pill was removed — usage lives in the
// top-bar token pill + limiter dialog instead.)
//
// Run 13: always mounted — the app shell (SenkuApp) owns the
// open/close animation and hover-peek lifecycle; this component
// just renders the panel at its fixed 264px width.

import { useMemo, useState } from "react";
import Image from "next/image";
import {
  ChevronRight,
  CircleHelp,
  Folder,
  Languages,
  LogOut,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import { useSenku } from "@/lib/store";
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
    searchOpen,
    searchFilter,
    temporary,
    setSearchOpen,
    setSearchFilter,
    newChat,
    selectChat,
    deleteChat,
  } = useSenku();
  const { toast } = useToast();

  const [projectsOpen, setProjectsOpen] = useState(true);
  const [recentOpen, setRecentOpen] = useState(true);

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
        onClick={newChat}
        className="mx-3 mt-3 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-zinc-200 transition-colors hover:bg-white/5"
      >
        <Pencil className="h-4 w-4 text-zinc-400" />
        New chat
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
                filteredChats.map((chat) => (
                  <div
                    key={chat.id}
                    className={`group flex items-center rounded-lg transition-colors ${
                      currentChatId === chat.id && !temporary
                        ? "bg-white/10"
                        : "hover:bg-white/5"
                    }`}
                  >
                    <button
                      onClick={() => void selectChat(chat.id)}
                      className="min-w-0 flex-1 truncate px-2.5 py-2 text-left text-[13px] text-zinc-300 group-hover:text-zinc-100"
                      title={chat.title}
                    >
                      {chat.title}
                    </button>
                    <button
                      aria-label={`Delete chat: ${chat.title}`}
                      onClick={() => void deleteChat(chat.id)}
                      className="mr-1 hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-white/10 hover:text-red-400 group-hover:flex"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
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
