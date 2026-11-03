"use client";

// Hermes — left sidebar: brand row, new chat,
// Projects/Recent accordions, user card + settings popover.
// (The old provider/tokens pill was removed — usage lives in the
// top-bar token pill + limiter dialog instead.)
//
// Run 13: always mounted — the app shell (HermesApp) owns the
// open/close animation and hover-peek lifecycle; this component
// just renders the panel at its fixed 264px width.
//
// Run 15: every chat row gets a 3-dot action menu — Rename (inline,
// no page refresh), Export as Markdown / JSON (clean download), and
// Delete (SQLite wipe). The menu reveals on hover/focus, exactly
// like the old trash button, but with all three actions.
//
// Run 37 — THE PROJECTS: the stub becomes a living section.
// Projects are folders that carry their own instructions; chats
// nest under their project, Recent lists only unfiled chats, every
// chat menu gains “Move to project”, and project rows get their own
// menu (rename / edit instructions / new chat / delete). Deleting a
// project keeps its chats (SetNull) — nothing is ever lost.

import { useMemo, useRef, useState } from "react";
import Image from "next/image";
import {
  Brain,
  CalendarClock,
  ChevronRight,
  CircleHelp,
  Download,
  FileJson,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  FolderOpen,
  Images,
  Languages,
  LogOut,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Settings,
  Smartphone,
  Trash2,
} from "lucide-react";
import { useHermes, type ChatListItem, type ProjectItem } from "@/lib/store";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import {
  chatToMarkdown,
  downloadText,
  safeFilename,
  type ExportMessage,
} from "@/lib/hermes/export";

export function Sidebar({
  onManageProviders,
  onOpenMemory,
  onOpenRituals,
  onEditProject,
  onCollapse,
}: {
  onManageProviders: () => void;
  onOpenMemory: () => void;
  onOpenRituals: () => void;
  /** Run 37 — open the project editor (null → create mode). */
  onEditProject: (project: ProjectItem | null) => void;
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
    // Run 27 — one-click "Install App" from the profile menu.
    installPrompt,
    pwaStandalone,
    setInstallPrompt,
    // Run 28 — memory count badge for the profile menu.
    memories,
    // Run 34 — scheduled prompts (the Rituals row + badge).
    rituals,
    // Run 37 — THE PROJECTS: list + moves.
    projects,
    moveChat,
    deleteProject,
    draftProjectId,
  } = useHermes();
  const { toast } = useToast();

  // Run 27 — install affordance. Chrome/Edge/Brave fire
  // beforeinstallprompt (captured in the store by PWARegistrar) and
  // the item becomes a real one-click install. iOS Safari has NO
  // programmatic prompt — there the item is an honest hint pointing
  // at Share → "Add to Home Screen". Either way it hides itself once
  // the app already runs installed (standalone).
  const isIOS =
    typeof navigator !== "undefined" &&
    (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
      // iPadOS 13+ masquerades as desktop Safari
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

  const handleInstallClick = async () => {
    if (installPrompt) {
      const ev = installPrompt;
      setInstallPrompt(null); // prompt() is one-shot per event
      try {
        await ev.prompt();
        const { outcome } = await ev.userChoice;
        toast({
          description:
            outcome === "accepted"
              ? "Installing Hermes — it will land on your home screen / desktop."
              : "Install dismissed — you can install any time from this menu.",
        });
      } catch {
        toast({ description: "Install was cancelled." });
      }
      return;
    }
    toast({
      description:
        'In Safari: tap Share (⬆︎), then "Add to Home Screen" — the app installs from there.',
    });
  };

  const [projectsOpen, setProjectsOpen] = useState(true);
  const [recentOpen, setRecentOpen] = useState(true);
  // Run 37 — which project rows are expanded (nested chats).
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    new Set()
  );
  const toggleProject = (id: string) =>
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
    const unfiled = chats.filter((c) => !c.projectId);
    return f ? unfiled.filter((c) => c.title.toLowerCase().includes(f)) : unfiled;
  }, [chats, searchFilter]);

  // Run 37 — chats nested under a project row (membership, not
  // search — the search box filters Recent, projects stay whole).
  const chatsOf = (projectId: string) =>
    chats.filter((c) => c.projectId === projectId);

  /** Run 37 — move a chat between project / Recent, with an honest
   *  toast either way (the lists refresh through the store). */
  const doMove = async (chat: ChatListItem, projectId: string | null) => {
    if (chat.projectId === projectId) return;
    const result = await moveChat(chat.id, projectId);
    if (!result.ok) {
      toast({ variant: "destructive", description: result.error ?? "Move failed." });
      return;
    }
    const target = projectId
      ? projects.find((p) => p.id === projectId)?.name
      : null;
    toast({
      description: target
        ? `“${chat.title}” moved to ${target}.`
        : `“${chat.title}” moved back to Recent.`,
    });
  };

  /** Run 37 — delete a project: chats survive (SetNull → Recent). */
  const doDeleteProject = async (project: ProjectItem) => {
    const result = await deleteProject(project.id);
    if (!result.ok) {
      toast({ variant: "destructive", description: "Delete failed." });
      return;
    }
    toast({
      description:
        typeof result.releasedChats === "number" && result.releasedChats > 0
          ? `Project “${project.name}” deleted — ${result.releasedChats} chat${
              result.releasedChats === 1 ? "" : "s"
            } returned to Recent.`
          : `Project “${project.name}” deleted.`,
    });
  };

  // One chat row renderer, reused by Recent AND project nesting
  // (Run 37). `nested` only shifts the padding — the row, its
  // inline-rename state and its 3-dot menu (now with the Move
  // submenu) are identical everywhere a chat can appear.
  const renderChatRow = (chat: ChatListItem, nested = false) => {
    if (renamingId === chat.id) {
      return (
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
      );
    }
    return (
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
          className={`min-w-0 flex-1 truncate py-2 pr-1 text-left text-[13px] text-zinc-300 group-hover:text-zinc-100 ${
            nested ? "pl-8" : "pl-2.5"
          }`}
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
            className="w-52 border-zinc-800 bg-[#262627] text-zinc-200"
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
            {/* Run 37 — file the chat: project submenu, with an
                honest "No project" exit back to Recent. */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="gap-2.5 py-2 text-[13px]">
                <FolderInput className="h-4 w-4 text-zinc-400" />
                Move to project
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48 border-zinc-800 bg-[#262627] text-zinc-200">
                {projects.length === 0 ? (
                  <DropdownMenuItem
                    className="gap-2.5 py-2 text-[13px]"
                    onClick={() => onEditProject(null)}
                  >
                    <FolderPlus className="h-4 w-4 text-amber-300/80" />
                    New project…
                  </DropdownMenuItem>
                ) : (
                  <>
                    {projects.map((p) => (
                      <DropdownMenuItem
                        key={p.id}
                        className="gap-2.5 py-2 text-[13px]"
                        disabled={chat.projectId === p.id}
                        onClick={() => void doMove(chat, p.id)}
                      >
                        {chat.projectId === p.id ? (
                          <FolderOpen className="h-4 w-4 text-amber-300" />
                        ) : (
                          <Folder className="h-4 w-4 text-zinc-400" />
                        )}
                        <span className="truncate">{p.name}</span>
                        {chat.projectId === p.id && (
                          <span className="ml-auto text-[10.5px] text-zinc-500">
                            here
                          </span>
                        )}
                      </DropdownMenuItem>
                    ))}
                    {chat.projectId && (
                      <>
                        <DropdownMenuSeparator className="bg-zinc-800" />
                        <DropdownMenuItem
                          className="gap-2.5 py-2 text-[13px]"
                          onClick={() => void doMove(chat, null)}
                        >
                          <MoreHorizontal className="h-4 w-4 text-zinc-400" />
                          No project (Recent)
                        </DropdownMenuItem>
                      </>
                    )}
                  </>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
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
    );
  };

  return (
    <aside
      className="flex h-full w-[264px] shrink-0 flex-col bg-[#212121]"
      aria-label="Sidebar"
    >
      {/* Brand row */}
      <div className="flex h-12 items-center gap-2 px-3">
        <Image
          src="/hermes-mark.png"
          alt="Hermes logo"
          width={875}
          height={1124}
          className="h-[26px] w-[26px] shrink-0 object-contain object-center"
          priority
        />
        <span className="truncate text-[15px] font-semibold text-white">
          Hermes
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

      {/* Run 34 — scheduled prompts. The badge is the honest ritual
          count (active + paused — the dialog manages them); opening
          the dialog is a management action, not a view switch. */}
      <button
        onClick={() => {
          closeDrawerOnMobile();
          onOpenRituals();
        }}
        className="mx-3 mt-1.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-zinc-200 transition-colors hover:bg-white/5"
      >
        <CalendarClock className="h-4 w-4 text-zinc-400" />
        Rituals
        {rituals.length > 0 && (
          <span
            className="ml-auto rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-zinc-400"
            title={`${rituals.filter((r) => r.isActive).length} active of ${rituals.length} scheduled`}
          >
            {rituals.length}
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
      <nav className="hermes-scroll mt-3 flex-1 overflow-y-auto pb-2">
        {/* Projects — Run 37: folders that carry their own
            instructions. Rows expand to their nested chats; the
            header's plus and the empty-state CTA both open the
            editor dialog. */}
        <div>
          <div className="group/projhead flex items-center pr-3">
            <button
              onClick={() => setProjectsOpen(!projectsOpen)}
              className="flex min-w-0 flex-1 items-center gap-1.5 px-4 py-1.5 text-[13px] font-medium text-zinc-300 transition-colors hover:text-white"
              aria-expanded={projectsOpen}
            >
              <ChevronRight
                className={`h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform ${
                  projectsOpen ? "rotate-90" : ""
                }`}
              />
              Projects
              {projects.length > 0 && (
                <span
                  className="ml-1 rounded-full bg-white/10 px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-zinc-400"
                  title={`${projects.length} project${projects.length === 1 ? "" : "s"}`}
                >
                  {projects.length}
                </span>
              )}
            </button>
            <button
              aria-label="New project"
              title="New project"
              onClick={() => onEditProject(null)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-amber-300"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
          </div>
          {projectsOpen &&
            (projects.length === 0 ? (
              <button
                onClick={() => onEditProject(null)}
                className="mx-2 mt-0.5 flex w-[calc(100%-1rem)] items-center gap-2 rounded-lg py-2 pl-[26px] pr-2.5 text-left text-[13px] text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
              >
                <FolderPlus className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                <span className="italic">Create your first project</span>
              </button>
            ) : (
              <div className="mt-0.5 px-2">
                {projects.map((project) => {
                  const expanded = expandedProjects.has(project.id);
                  const nested = chatsOf(project.id);
                  const isDraftHome =
                    draftProjectId === project.id && !currentChatId;
                  return (
                    <div key={project.id}>
                      <div
                        className={`group/proj flex items-center rounded-lg transition-colors ${
                          isDraftHome
                            ? "bg-amber-400/10"
                            : "hover:bg-white/5"
                        }`}
                      >
                        <button
                          onClick={() => toggleProject(project.id)}
                          aria-expanded={expanded}
                          className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2.5 pr-1 text-left text-[13px] font-medium text-zinc-200"
                          title={
                            project.instructions
                              ? "Has instructions — edits via the ⋯ menu"
                              : "Folder"
                          }
                        >
                          {expanded ? (
                            <FolderOpen className="h-4 w-4 shrink-0 text-amber-300/90" />
                          ) : (
                            <Folder className="h-4 w-4 shrink-0 text-zinc-400" />
                          )}
                          <span className="truncate">{project.name}</span>
                          {project.instructions.trim() && (
                            <span
                              className="h-1 w-1 shrink-0 rounded-full bg-amber-300/90"
                              title="Carries instructions"
                            />
                          )}
                        </button>
                        <button
                          aria-label={`New chat in ${project.name}`}
                          title={`New chat in ${project.name}`}
                          onClick={() => {
                            closeDrawerOnMobile();
                            newChat(project.id);
                          }}
                          className="mr-0.5 hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-amber-300 group-hover/proj:flex group-focus-within/proj:flex"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                        <span
                          className="mr-1 shrink-0 rounded-full bg-white/10 px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-zinc-400"
                          title={`${project.chatCount} chat${project.chatCount === 1 ? "" : "s"} in this project`}
                        >
                          {project.chatCount}
                        </span>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              aria-label={`Project actions: ${project.name}`}
                              title="Project actions"
                              className="mr-1 hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200 group-hover/proj:flex group-focus-within/proj:flex data-[state=open]:flex [@media(hover:none)]:flex"
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
                              {project.name}
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator className="bg-zinc-800" />
                            <DropdownMenuItem
                              className="gap-2.5 py-2 text-[13px]"
                              onClick={() => {
                                closeDrawerOnMobile();
                                newChat(project.id);
                              }}
                            >
                              <Plus className="h-4 w-4 text-zinc-400" />
                              New chat here
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="gap-2.5 py-2 text-[13px]"
                              onClick={() => onEditProject(project)}
                            >
                              <Pencil className="h-4 w-4 text-zinc-400" />
                              Edit instructions
                            </DropdownMenuItem>
                            <DropdownMenuSeparator className="bg-zinc-800" />
                            <DropdownMenuItem
                              className="gap-2.5 py-2 text-[13px] text-red-400 focus:bg-red-500/10 focus:text-red-300"
                              onClick={() => void doDeleteProject(project)}
                            >
                              <Trash2 className="h-4 w-4" />
                              Delete project
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      {expanded &&
                        (nested.length === 0 ? (
                          <p className="px-2 py-1 pl-8 text-[12.5px] italic text-zinc-500">
                            No chats yet —{" "}
                            <button
                              className="text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
                              onClick={() => {
                                closeDrawerOnMobile();
                                newChat(project.id);
                              }}
                            >
                              start one
                            </button>
                          </p>
                        ) : (
                          <div className="mt-0.5">
                            {nested.map((chat) => renderChatRow(chat, true))}
                          </div>
                        ))}
                    </div>
                  );
                })}
              </div>
            ))}
        </div>

        {/* Recent — unfiled chats only (Run 37); project chats live
            under their project rows above. */}
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
                filteredChats.map((chat) => renderChatRow(chat))
              )}
            </div>
          )}
        </div>
      </nav>

      {/* User card + settings popover */}
      <div className="border-t border-zinc-800/80 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
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
              {/* Run 28 — persistent personal memory. The badge is the
                  live count (hidden when empty — the item teaches
                  itself the first time something is remembered). */}
              <DropdownMenuItem
                className="gap-2.5 py-2 text-[13px]"
                onClick={onOpenMemory}
              >
                <Brain className="h-4 w-4 text-zinc-400" />
                Memory
                {memories.length > 0 && (
                  <span className="ml-auto rounded-full bg-amber-400/15 px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-amber-300">
                    {memories.length}
                  </span>
                )}
              </DropdownMenuItem>
              {!pwaStandalone && (installPrompt || isIOS) && (
                <DropdownMenuItem
                  className="gap-2.5 py-2 text-[13px]"
                  onClick={() => void handleInstallClick()}
                >
                  {installPrompt ? (
                    <Download className="h-4 w-4 text-emerald-400" />
                  ) : (
                    <Smartphone className="h-4 w-4 text-zinc-400" />
                  )}
                  {installPrompt ? "Install App" : "Add to Home Screen"}
                </DropdownMenuItem>
              )}
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
