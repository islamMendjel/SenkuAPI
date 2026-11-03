"use client";

// Hermes — client store (Zustand). Owns bootstrap data, chat state
// and the SSE streaming turn pipeline.

import { create } from "zustand";
import { DEFAULT_MODEL } from "@/lib/hermes/constants";
import { sizeFromDims } from "@/lib/hermes/image-forge";
import { countLines } from "@/lib/hermes/format";
import { autoChallenger } from "@/lib/hermes/models";
import { StreamFlushScheduler } from "@/lib/hermes/raf-throttle";
import type {
  AttachmentRecord,
  ChatMessageData,
  EffortLevel,
  ImageRef,
  ImageSize,
  LimiterStatus,
  ProviderView,
  RitualView,
  SearchSource,
  TurnStyle,
} from "@/lib/hermes/types";

/** One file being attached to the next message — extraction runs
 *  server-side the moment the file is picked, so the chip can show
 *  exactly what the gateway read BEFORE the user sends. */
export interface PendingAttachment {
  id: string;
  name: string;
  kindGuess: "text" | "pdf" | "image" | "unknown";
  status: "extracting" | "ready" | "error";
  error?: string;
  record?: AttachmentRecord;
}

/** A code block staged into the Hermes Canvas (the Tools aside).
 *  Kept in the store so the preview survives close/reopen and chat
 *  navigation — closing the canvas never touches the conversation. */
export interface CanvasSource {
  /** canonical preview language: html | svg | mermaid | javascript | python */
  language: string;
  code: string;
}

/** One racing model inside a duel turn. */
export interface DuelLane {
  id: "a" | "b";
  model: string;
  content: string;
  streaming: boolean;
  error: string | null;
  phase: "searching" | "thinking" | null;
  tokens: number;
  cached: boolean;
  servedBy: string | null;
  keyLabel: string | null;
}

/** One previous answer of a regenerated turn. The ACTIVE answer
 *  always lives on the message itself (content/model/tokens/…) —
 *  `variants` holds every earlier one, full provenance included,
 *  so flipping back shows honest per-answer receipts. */
export interface AnswerVariant {
  content: string;
  model: string;
  tokens: number;
  cached: boolean;
  servedBy: string | null;
  keyLabel: string | null;
  effort: EffortLevel | null;
  /** Run 22 — image re-roll variants carry their ImageRef; text
   *  variants simply omit it. */
  image?: ImageRef | null;
}

export interface UIMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  model?: string | null;
  provider?: string | null;
  keyLabel?: string | null;
  tokens?: number;
  cached?: boolean;
  /** true when the token count is a chars/4 estimate because the
   *  provider did not report usage (Run 17 honesty marker) */
  tokensEstimated?: boolean;
  servedBy?: string | null;
  sources?: SearchSource[] | null;
  /** files the gateway read and sent with this message */
  attachments?: AttachmentRecord[] | null;
  createdAt?: string;
  streaming?: boolean;
  error?: string | null;
  /** live phase while waiting for the first delta */
  phase?: "searching" | "thinking" | null;
  /** deep-research stage label while the search pipeline runs */
  searchDetail?: string | null;
  /** effort level that served (or is serving) this turn */
  effort?: EffortLevel | null;
  /** set when web search was requested but every engine failed */
  searchFailed?: boolean;
  /** present while a duel turn awaits the user's pick */
  duel?: { a: DuelLane; b: DuelLane } | null;
  /** which lane the user kept ("a" | "b"), once picked */
  duelPicked?: "a" | "b" | null;
  /** the losing lane, kept as a viewable reference after the pick */
  runnerUp?: { content: string; model: string } | null;
  /** earlier answers of this turn (regenerate history) — the
   *  active one lives in content/model above */
  variants?: AnswerVariant[] | null;
  /** index of the active answer inside `variants` */
  variantIndex?: number | null;
  /** Run 22 — the ACTIVE forged image (rendered as an image card
   *  instead of markdown). `content` keeps a text marker so search,
   *  export and model history stay meaningful. */
  image?: ImageRef | null;
  /** true while the Image Forge is generating this turn's image */
  imagePending?: boolean;
  /** set on USER bubbles sent through Image mode — drives the
   *  bubble badge and routes Retry back to the forge (client-only:
   *  failed turns are never persisted, so no column is needed) */
  imageRequest?: { size: ImageSize } | null;
  /** Run 34 — set on user messages a scheduled ritual fired (the
   *  scheduler stamps the persisted row). Drives the "Ritual ·
   *  <title>" badge on the bubble; the title resolves from the
   *  ritual list, falling back to "Ritual". */
  ritualId?: string | null;
  /** Run 39 — THE FORK: where this message sits in its sibling
   *  group (‹ k/N › switcher). Only fork-group members carry them;
   *  siblingCount 1 = no switcher. */
  branchIndex?: number;
  siblingCount?: number;
  siblingPosition?: number;
}

export interface ChatListItem {
  id: string;
  title: string;
  model: string;
  provider: string;
  /** Run 37 — the project this chat belongs to (null = Recent). */
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Run 37 — one project: a folder for chats WITH its own
 *  instructions, injected into every turn of every chat inside it
 *  (server-side, gateway → projectBlock). The sidebar section,
 *  the move submenu and the ⌘K palette read this list. */
export interface ProjectItem {
  id: string;
  name: string;
  instructions: string;
  chatCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Run 27 — Chrome's beforeinstallprompt event. Not in the standard
 *  DOM typings, so the PWA registrar and the profile menu share this
 *  minimal, honest shape. */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
}

/** Run 28 — one persistent memory entry (durable fact or preference
 *  the user asked the gateway to remember; injected into every
 *  system prompt server-side). */
export interface MemoryItem {
  id: string;
  content: string;
}

/** Run 34 — one scheduled prompt, as the dialog renders it. The
 * server owns the shape (RitualView in lib/hermes/types); this
 * alias keeps the MemoryItem convention for client components. */
export type RitualItem = RitualView;

interface UserInfo {
  name: string;
  email: string;
  plan: string;
}

interface HermesState {
  user: UserInfo;
  providers: ProviderView[];
  limiter: LimiterStatus | null;
  chats: ChatListItem[];
  models: string[];

  sidebarOpen: boolean;
  searchOpen: boolean;
  searchFilter: string;
  searchEnabled: boolean;
  temporary: boolean;
  model: string;
  /** duel mode: next send races two models, user keeps the winner */
  duelEnabled: boolean;
  /** the lane-B model (null when the pool has no second model) */
  challenger: string | null;
  /** effort dial — fast / medium (default) / deep */
  effort: EffortLevel;
  /** Run 22 — Image Forge mode: the next message is forged into an
   *  image instead of streamed as text. Mutually exclusive with
   *  Search and Duel (different pipelines — arming one disarms the
   *  others, so a send can never be ambiguous). */
  imageMode: boolean;
  /** dimensions for the next forged image */
  imageSize: ImageSize;
  toggleImageMode: () => void;
  setImageSize: (s: ImageSize) => void;
  /** Forge an image from a prompt (Run 22). Mirrors sendMessage's
   *  lifecycle: optimistic bubbles, abortable via Stop, error card
   *  with retry, re-rolls arrive with variant snapshots attached. */
  sendImage: (
    prompt: string,
    opts?: {
      appendUserBubble?: boolean;
      persistUser?: boolean;
      size?: ImageSize;
      regenVariants?: AnswerVariant[];
    }
  ) => Promise<void>;

  currentChatId: string | null;
  messages: UIMessage[];
  streaming: boolean;
  booted: boolean;
  /** Bumped on every conversation navigation (new chat, entering
   *      a chat, deleting the current chat) — the app shell keys the
   *      timeline view on it so each navigation plays the view-in
   *      transition exactly once (and never mid-stream). */
  viewEpoch: number;
  /** files staged for the NEXT message (extraction runs at pick time) */
  pendingAttachments: PendingAttachment[];

  /** Run 17 — one-shot response style for the NEXT message, armed by
   *  the /code and /concise slash commands, shown as a removable pill. */
  turnStyle: TurnStyle | null;
  setTurnStyle: (s: TurnStyle | null) => void;
  /** Stage a >60-line pasted snippet as an attachment pill. The exact
   *  text stays client-side until the user SENDS (explicit action) —
   *  no upload, no persistence at paste time. */
  stagePastedSnippet: (text: string) => { ok: boolean; error?: string };

  /** Run 17 — Hermes Canvas state (the Tools aside). The source is
   *  kept across close/reopen so the user never loses a preview. */
  canvasOpen: boolean;
  canvasSource: CanvasSource | null;
  openCanvas: (src: CanvasSource) => void;
  closeCanvas: () => void;
  setCanvasOpen: (open: boolean) => void;

  /** Run 23 — the image Gallery view (sidebar → Images). Opening it
   *  swaps the timeline for a masonry of every forged image, from
   *  every saved chat. Any conversation navigation (new chat, enter
   *  chat, mode switch) or any send closes it again — the gallery is
   *  a destination, never a dead end. */
  galleryOpen: boolean;
  /** forged images across all saved chats (the sidebar badge;
   *  bootstrap-seeded, +1 per persisted forge, refreshed on delete) */
  imageCount: number;
  openGallery: () => void;
  closeGallery: () => void;

  /** Run 26 — when set, the timeline scrolls this message into view
   *  and flashes it once (jump-to-message from ⌘K content search).
   *  The timeline clears it after the flash plays; every conversation
   *  navigation (newChat/selectChat) also clears it so a stale id
   *  from a previous chat can never flash in the wrong place. */
  highlightMessageId: string | null;
  flashMessage: (id: string | null) => void;

  /** Run 27 — PWA install. `installPrompt` stashes Chrome's
   *  beforeinstallprompt event (fired once criteria — manifest, icons,
   *  service worker, HTTPS — are met) so the profile menu can offer a
   *  one-click "Install App". `pwaStandalone` is true when the app is
   *  already running installed (display-mode: standalone or iOS
   *  navigator.standalone) — the install entry hides itself then. */
  installPrompt: BeforeInstallPromptEvent | null;
  pwaStandalone: boolean;
  setInstallPrompt: (ev: BeforeInstallPromptEvent | null) => void;
  setPwaStandalone: (v: boolean) => void;

  /** Run 28 — persistent personal memory: durable facts/preferences
   *  the user asked the gateway to remember. Injected into every
   *  system prompt by the gateway (see lib/hermes/memory.ts); the
   *  bootstrap seeds the list, the MemoryDialog owns the CRUD, and
   *  the welcome screen surfaces "remembers N things" when N > 0. */
  memories: MemoryItem[];
  addMemory: (content: string) => Promise<boolean>;
  updateMemory: (id: string, content: string) => Promise<boolean>;
  deleteMemory: (id: string) => Promise<boolean>;

  /** Run 34 — scheduled prompts (Rituals): each fires server-side on
   *  its own clock and lands in its dedicated chat. The list drives
   *  the sidebar row badge + the management dialog; the dialog polls
   *  refreshRituals while open so countdowns/status stay live. */
  rituals: RitualItem[];
  refreshRituals: () => Promise<void>;
  createRitual: (input: {
    title: string;
    prompt: string;
    kind: "daily" | "weekly" | "interval";
    hour: number;
    minute: number;
    weekday: number;
    intervalMin: number;
    search: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  toggleRitual: (id: string, isActive: boolean) => Promise<boolean>;
  editRitual: (
    id: string,
    patch: { title?: string; prompt?: string }
  ) => Promise<boolean>;
  deleteRitual: (id: string) => Promise<boolean>;
  runRitualNow: (
    id: string
  ) => Promise<{ ok: boolean; error?: string; status?: string }>;

  /** Run 37 — THE PROJECTS: chats that live in folders, folders
   *  that carry their own instructions. `draftProjectId` names the
   *  project the NEXT new chat is born into (set by newChat(id) /
   *  the project row's plus button; cleared by any navigation).
   *  The current chat's project is derived from its row — server
   *  truth on every turn. */
  projects: ProjectItem[];
  draftProjectId: string | null;
  refreshProjects: () => Promise<void>;
  createProject: (
    name: string,
    instructions: string
  ) => Promise<{ ok: boolean; error?: string; id?: string }>;
  updateProject: (
    id: string,
    patch: { name?: string; instructions?: string }
  ) => Promise<{ ok: boolean; error?: string }>;
  deleteProject: (id: string) => Promise<{ ok: boolean; releasedChats?: number }>;
  /** Move a chat into a project (or back to Recent with null). */
  moveChat: (
    chatId: string,
    projectId: string | null
  ) => Promise<{ ok: boolean; error?: string }>;

  /** Upload files for extraction — each becomes a chip showing what
   *      the gateway read (or why it couldn't be read). */
  addAttachments: (files: File[]) => Promise<void>;
  removePendingAttachment: (id: string) => void;

  bootstrap: () => Promise<void>;
  refreshUsage: () => Promise<void>;
  refreshChats: () => Promise<void>;
  setSidebarOpen: (v: boolean) => void;
  setSearchOpen: (v: boolean) => void;
  setSearchFilter: (v: string) => void;
  toggleSearch: () => void;
  setSearchEnabled: (v: boolean) => void;
  toggleTemporary: () => void;
  setModel: (m: string) => void;
  toggleDuel: () => void;
  setChallenger: (m: string) => void;
  setEffort: (e: EffortLevel) => void;
  /** Keep one lane of an awaiting-pick duel as the canonical
        assistant reply (persists it server-side for saved chats). */
  pickDuelWinner: (messageId: string, lane: "a" | "b") => Promise<void>;
  syncModels: () => Promise<boolean>;
  switchProvider: (providerId: string) => Promise<void>;
  addKey: (providerId: string, label: string, key: string) => Promise<void>;
  deleteKey: (keyId: string) => Promise<void>;
  toggleKey: (keyId: string, isActive: boolean) => Promise<void>;

  newChat: (projectId?: string | null) => void;
  selectChat: (id: string) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
  /** Rename a chat (optimistic — rolls back to the server list on
      failure). Returns true when the new title stuck. */
  renameChat: (id: string, title: string) => Promise<boolean>;
  sendMessage: (content: string) => Promise<void>;
  editMessage: (messageId: string, content: string) => Promise<void>;
  /** Re-run the turn that produced the last failed assistant reply,
      optionally with a different model (error-card "switch model"). */
  retryLast: (modelOverride?: string) => Promise<void>;
  /** Regenerate the LAST assistant answer: the current answer is
      snapshotted into the message's variant history and the turn
      re-streams. Available on every completed answer (not just
      errors) — the standard chat capability. */
  regenerate: () => Promise<void>;
  /** Flip a message's active answer to the previous/next variant
      (the ‹ 2/3 › control). Persists for saved chats. */
  navigateVariant: (messageId: string, dir: -1 | 1) => Promise<void>;
  /** Run 39 — THE FORK: flip the displayed conversation to the
      previous/next sibling branch at a fork point (the ‹ k/N ›
      switcher on edited turns). Saved chats only. */
  switchBranch: (messageId: string, dir: -1 | 1) => Promise<void>;
  stopStreaming: () => void;
}

let streamController: AbortController | null = null;

/** Fires exactly when the usage day rolls over (01:00 Africa/Algiers),
 *  so the daily token counter visibly resets to 0 at that moment —
 *  no polling loop, one timer armed from the server's own schedule. */
let rolloverTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleDailyRolloverRefresh(dailyResetsAt?: string) {
  if (rolloverTimer) {
    clearTimeout(rolloverTimer);
    rolloverTimer = null;
  }
  if (typeof dailyResetsAt !== "string") return;
  const at = new Date(dailyResetsAt).getTime();
  if (!Number.isFinite(at)) return;
  const delay = Math.max(at - Date.now() + 1000, 30_000); // never tighter than 30s
  rolloverTimer = setTimeout(() => {
    rolloverTimer = null;
    void useHermes.getState().refreshUsage();
  }, delay);
}

function applyProviderView(
  providers: ProviderView[],
  view: ProviderView
): ProviderView[] {
  return providers.map((p) => (p.id === view.id ? view : p));
}

export const useHermes = create<HermesState>((set, get) => ({
  user: {
    name: "hermes",
    email: "gamerislam21@gmail.com",
    plan: "Ultimate plan (unlimited)",
  },
  providers: [],
  limiter: null,
  chats: [],
  models: [],

  // Run 15: the sidebar starts CLOSED on launch (the user asked for
  // it explicitly). It opens on click, on hover-peek over the
  // top-bar toggle, and — on mobile — stays an overlay drawer.
  sidebarOpen: false,
  searchOpen: false,
  searchFilter: "",
  searchEnabled: false,
  temporary: false,
  model: "free/glm-5.3",
  duelEnabled: false,
  challenger: null,
  effort: "medium",
  imageMode: false,
  imageSize: "square",

  currentChatId: null,
  messages: [],
  streaming: false,
  booted: false,
  viewEpoch: 0,
  pendingAttachments: [],
  turnStyle: null,
  canvasOpen: false,
  canvasSource: null,
  highlightMessageId: null,
  galleryOpen: false,
  imageCount: 0,
  // Run 37 — projects (folders with instructions).
  projects: [],
  draftProjectId: null,

  async addAttachments(files) {
    const existing = get().pendingAttachments;
    const room = 5 - existing.length;
    if (room <= 0) {
      return; // caller toasts about the cap
    }
    const accepted = files.slice(0, room);
    const skipped = files.length - accepted.length;
    const staged: PendingAttachment[] = accepted.map((f) => ({
      id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: f.name,
      kindGuess: f.type.startsWith("image/")
        ? "image"
        : f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")
          ? "pdf"
          : f.type.startsWith("text/") || f.name.includes(".")
            ? "text"
            : "unknown",
      status: "extracting",
    }));
    set({ pendingAttachments: [...existing, ...staged] });
    if (skipped > 0) return; // cap message handled by the caller

    try {
      const form = new FormData();
      for (const f of accepted) form.append("files", f);
      const res = await fetch("/api/attachments/extract", {
        method: "POST",
        body: form,
      });
      const data = (await res.json().catch(() => ({}))) as {
        records?: AttachmentRecord[];
        errors?: { name: string; error: string }[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || "Extraction failed");
      const records = data.records ?? [];
      const errors = data.errors ?? [];
      set((s) => ({
        pendingAttachments: s.pendingAttachments.map((p) => {
          const rec = records.find((r) => r.name === p.name);
          if (rec) {
            return {
              ...p,
              status: "ready" as const,
              kindGuess: rec.kind,
              record: rec,
            };
          }
          const err = errors.find((e) => e.name === p.name);
          if (err) {
            return { ...p, status: "error" as const, error: err.error };
          }
          // No result at all (name mismatch etc.) — treat as error.
          return {
            ...p,
            status: "error" as const,
            error: "Could not read this file.",
          };
        }),
      }));
    } catch (e) {
      // Whole upload failed — every staged file errors out.
      const msg = (e as Error).message || "Extraction failed";
      set((s) => ({
        pendingAttachments: s.pendingAttachments.map((p) =>
          staged.some((q) => q.id === p.id)
            ? { ...p, status: "error" as const, error: msg }
            : p
        ),
      }));
    }
  },

  removePendingAttachment: (id) =>
    set((s) => ({
      pendingAttachments: s.pendingAttachments.filter((p) => p.id !== id),
    })),

  async bootstrap() {
    try {
      const res = await fetch("/api/bootstrap");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const models: string[] = data.activeProvider?.models ?? [];
      set({
        user: data.user ?? get().user,
        providers: data.providers ?? [],
        limiter: data.limiter ?? null,
        chats: data.chats ?? [],
        models,
        imageCount: typeof data.imageCount === "number" ? data.imageCount : 0,
        // Run 28 — memory list for the welcome indicator + dialog.
        memories: Array.isArray(data.memories)
          ? data.memories
              .filter(
                (m: unknown): m is MemoryItem =>
                  !!m && typeof (m as MemoryItem).id === "string" &&
                  typeof (m as MemoryItem).content === "string"
              )
              .map((m: MemoryItem) => ({ id: m.id, content: m.content }))
          : [],
        // Run 34 — scheduled prompts (sidebar badge + dialog).
        rituals: Array.isArray(data.rituals) ? (data.rituals as RitualItem[]) : [],
        // Run 37 — projects (sidebar section + move submenu + ⌘K).
        projects: Array.isArray(data.projects)
          ? (data.projects as ProjectItem[])
          : [],
        // Every fresh session boots on the default model (glm-5.3).
        model: models.includes(DEFAULT_MODEL)
          ? DEFAULT_MODEL
          : models[0] ?? DEFAULT_MODEL,
        // A stale challenger (from a previous provider's list) is
        // dropped — it is re-derived the next time duel is armed.
        challenger: null,
        booted: true,
      });
    } catch (e) {
      console.error("bootstrap failed", e);
      set({ booted: true });
    }
  },

  async refreshUsage() {
    try {
      const res = await fetch("/api/usage");
      const data = await res.json();
      if (!data.error) {
        set({ providers: data.providers ?? [], limiter: data.limiter ?? null });
        scheduleDailyRolloverRefresh(data.limiter?.dailyResetsAt);
      }
    } catch {
      // non-fatal
    }
  },

  async refreshChats() {
    try {
      const res = await fetch("/api/chats");
      const chats = await res.json();
      if (Array.isArray(chats)) set({ chats });
    } catch {
      // non-fatal
    }
  },

  setSidebarOpen: (v) => set({ sidebarOpen: v }),
  setSearchOpen: (v) => set({ searchOpen: v, searchFilter: v ? get().searchFilter : "" }),
  setSearchFilter: (v) => set({ searchFilter: v }),
  // Arming search disarms Image mode (a forged image never runs a
  // web search — the modes are different pipelines, Run 22).
  toggleSearch: () =>
    set((s) => ({
      searchEnabled: !s.searchEnabled,
      imageMode: !s.searchEnabled ? false : s.imageMode,
    })),
  setSearchEnabled: (v) => set({ searchEnabled: v }),
  toggleTemporary: () =>
    set((s) => ({
      temporary: !s.temporary,
      // switching modes always starts a fresh conversation so persisted
      // history never mixes with ephemeral messages
      currentChatId: null,
      messages: [],
      // staged files belong to the abandoned conversation
      pendingAttachments: [],
      // Run 37 — the draft project belonged to the abandoned
      // conversation too; a fresh start is unscoped until said otherwise.
      draftProjectId: null,
      // Run 23 — a mode switch is a navigation: leave the gallery.
      galleryOpen: false,
    })),
  setModel: (m) =>
    set((s) => ({
      model: m,
      // The challenger can never be the primary — re-derive it when
      // the user switches onto the challenger's model mid-duel-arm.
      challenger:
        s.duelEnabled && s.challenger === m
          ? autoChallenger(s.models, m)
          : s.challenger,
    })),
  toggleDuel: () => {
    const s = get();
    if (!s.duelEnabled) {
      // Arming: reuse a still-valid challenger, else auto-pick a
      // contrasting one (different family when possible).
      const challenger =
        s.challenger &&
        s.challenger !== s.model &&
        s.models.includes(s.challenger)
          ? s.challenger
          : autoChallenger(s.models, s.model);
      if (!challenger) return; // nothing to duel against
      // Arming duel disarms Image mode (duels race text models).
      set({ duelEnabled: true, challenger, imageMode: false });
    } else {
      set({ duelEnabled: false });
    }
  },
  setChallenger: (m) => set({ challenger: m }),
  setEffort: (e) => set({ effort: e }),

  // Arming Image mode disarms Search + Duel: a forged image is
  // neither grounded nor a race — the composer pill, placeholder and
  // send all switch to the forge pipeline (Run 22).
  toggleImageMode: () =>
    set((s) => ({
      imageMode: !s.imageMode,
      ...(!s.imageMode ? { searchEnabled: false, duelEnabled: false } : {}),
    })),
  setImageSize: (v) => set({ imageSize: v }),

  async syncModels() {
    try {
      const res = await fetch("/api/models?sync=1");
      const data = await res.json();
      if (Array.isArray(data.models) && data.models.length) {
        const models: string[] = data.models;
        set((s) => ({
          models,
          model: models.includes(s.model)
            ? s.model
            : models.includes(DEFAULT_MODEL)
              ? DEFAULT_MODEL
              : models[0],
          // The list changed — a challenger that disappeared is dropped
          // (re-derived when duel is armed / at send time).
          challenger:
            s.challenger && models.includes(s.challenger) ? s.challenger : null,
        }));
        return data.synced === true;
      }
    } catch {
      // keep current list
    }
    return false;
  },

  async switchProvider(providerId) {
    const res = await fetch("/api/providers/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const models: string[] = data.activeProvider?.models ?? [];
    set((s) => ({
      providers: data.providers ?? s.providers,
      limiter: data.limiter ?? s.limiter,
      models,
      model: models.includes(s.model)
        ? s.model
        : models.includes(DEFAULT_MODEL)
          ? DEFAULT_MODEL
          : models[0] ?? s.model,
      // Provider switch → different model list; stale challenger dropped.
      challenger:
        s.challenger && models.includes(s.challenger) ? s.challenger : null,
    }));
  },

  async addKey(providerId, label, key) {
    const res = await fetch(`/api/providers/${providerId}/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, key }),
    });
    const view = await res.json();
    if (view.error) throw new Error(view.error);
    set((s) => ({ providers: applyProviderView(s.providers, view) }));
    await get().refreshUsage();
  },

  async deleteKey(keyId) {
    const res = await fetch(`/api/keys/${keyId}`, { method: "DELETE" });
    const view = await res.json();
    if (view.error) throw new Error(view.error);
    set((s) => ({ providers: applyProviderView(s.providers, view) }));
    await get().refreshUsage();
  },

  async toggleKey(keyId, isActive) {
    const res = await fetch(`/api/keys/${keyId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive }),
    });
    const view = await res.json();
    if (view.error) throw new Error(view.error);
    set((s) => ({ providers: applyProviderView(s.providers, view) }));
    await get().refreshUsage();
  },

  setTurnStyle(s) {
    set({ turnStyle: s });
  },

  stagePastedSnippet(text) {
    const t = text ?? "";
    // Hard sanity ceiling — anything past this is not a "snippet".
    if (t.length > 1_000_000) {
      return {
        ok: false,
        error: `Snippet is ${(t.length / 1_000_000).toFixed(1)}M characters — too large to attach. Save it as a file and attach that instead.`,
      };
    }
    const existing = get().pendingAttachments;
    if (existing.length >= 5) {
      return {
        ok: false,
        error: "Up to 5 attachments per message — remove one first.",
      };
    }
    const lines = countLines(t);
    // Built ENTIRELY client-side: no upload, no server call — the
    // exact pasted text leaves only when the user sends the message.
    const record: AttachmentRecord = {
      name: `Pasted snippet · ${lines} lines`,
      mime: "text/plain",
      kind: "text",
      method: "text-layer",
      chars: t.length,
      totalChars: t.length,
      truncated: false,
      extract: t,
    };
    set({
      pendingAttachments: [
        ...existing,
        {
          id: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: record.name,
          kindGuess: "text",
          status: "ready",
          record,
        },
      ],
    });
    return { ok: true };
  },

  openCanvas(src) {
    set({ canvasSource: src, canvasOpen: true });
  },

  closeCanvas() {
    set({ canvasOpen: false });
  },

  setCanvasOpen(open) {
    set({ canvasOpen: open });
  },

  // Run 23 — the Gallery view. Opening never disturbs the current
  // conversation (it stays selected behind the gallery until closed);
  // every conversation navigation closes it (see newChat/selectChat).
  openGallery: () => set({ galleryOpen: true }),
  closeGallery: () => set({ galleryOpen: false }),

  // Run 26 — jump-to-message target for ⌘K content-search hits.
  flashMessage: (id) => set({ highlightMessageId: id }),

  // Run 27 — PWA install plumbing (see interface for the contract).
  installPrompt: null,
  pwaStandalone: false,
  setInstallPrompt: (ev) => set({ installPrompt: ev }),
  setPwaStandalone: (v) => set({ pwaStandalone: v }),

  // Run 28 — persistent memory CRUD (the gateway reads the table on
  // every turn, so these are thin state mirrors of the API; errors
  // return false and the caller toasts).
  memories: [],
  async addMemory(content) {
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save.");
      set((s) => ({ memories: [...s.memories, { id: data.id, content: data.content }] }));
      return true;
    } catch {
      return false;
    }
  },
  async updateMemory(id, content) {
    try {
      const res = await fetch(`/api/memory/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save.");
      set((s) => ({
        memories: s.memories.map((m) => (m.id === id ? { ...m, content } : m)),
      }));
      return true;
    } catch {
      return false;
    }
  },
  async deleteMemory(id) {
    try {
      const res = await fetch(`/api/memory/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not delete.");
      set((s) => ({ memories: s.memories.filter((m) => m.id !== id) }));
      return true;
    } catch {
      return false;
    }
  },

  // Run 34 — Rituals: scheduled prompts. Thin state mirrors of the
  // API (the scheduler engine runs server-side); failures return
  // false / {ok:false} and the caller toasts the honest error.
  rituals: [],
  async refreshRituals() {
    try {
      const res = await fetch("/api/rituals");
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.rituals)) set({ rituals: data.rituals });
    } catch {
      // non-fatal — the next poll retries
    }
  },
  async createRitual(input) {
    try {
      const res = await fetch("/api/rituals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok) {
        return { ok: false, error: data.error || "Could not schedule." };
      }
      set((s) => ({
        rituals: [...s.rituals, data.ritual as RitualItem],
      }));
      // The dedicated chat joins Recent like any other (the server
      // just created it — the list only knows after a refresh).
      void get().refreshChats();
      return { ok: true };
    } catch {
      return { ok: false, error: "Could not schedule — network." };
    }
  },
  async toggleRitual(id, isActive) {
    try {
      const res = await fetch(`/api/rituals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const ritual = data.ritual as RitualItem;
      set((s) => ({
        rituals: s.rituals.map((r) => (r.id === id ? ritual : r)),
      }));
      return true;
    } catch {
      return false;
    }
  },
  async editRitual(id, patch) {
    try {
      const res = await fetch(`/api/rituals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const ritual = data.ritual as RitualItem;
      set((s) => ({
        rituals: s.rituals.map((r) => (r.id === id ? ritual : r)),
        // A renamed ritual renames its dedicated chat — keep the
        // sidebar in step without a full refetch.
        chats:
          ritual.title !== s.rituals.find((r) => r.id === id)?.title
            ? s.chats.map((c) =>
                c.id === ritual.chatId ? { ...c, title: ritual.title } : c
              )
            : s.chats,
      }));
      return true;
    } catch {
      return false;
    }
  },
  async deleteRitual(id) {
    try {
      const res = await fetch(`/api/rituals/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      set((s) => ({ rituals: s.rituals.filter((r) => r.id !== id) }));
      // The dedicated chat went with it (cascade) — refresh Recent.
      void get().refreshChats();
      return true;
    } catch {
      return false;
    }
  },
  async runRitualNow(id) {
    try {
      const res = await fetch(`/api/rituals/${id}/run`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        return { ok: false, error: data.error || "Run failed." };
      }
      // Both lists changed (status + nextRunAt; the chat gained a
      // turn and its updatedAt bumped it up Recent).
      void get().refreshRituals();
      void get().refreshChats();
      return { ok: true, status: data.status as string | undefined };
    } catch {
      return { ok: false, error: "Run failed — network." };
    }
  },

  // ── Run 37 — THE PROJECTS: folder CRUD + chat moves ──
  async refreshProjects() {
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      if (Array.isArray(data.projects)) set({ projects: data.projects });
    } catch {
      // non-fatal — the sidebar keeps the last known list
    }
  },

  async createProject(name, instructions) {
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, instructions }),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || "Create failed." };
      await get().refreshProjects();
      return { ok: true, id: data.project?.id as string | undefined };
    } catch {
      return { ok: false, error: "Create failed — network." };
    }
  },

  async updateProject(id, patch) {
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || "Save failed." };
      await get().refreshProjects();
      return { ok: true };
    } catch {
      return { ok: false, error: "Save failed — network." };
    }
  },

  async deleteProject(id) {
    try {
      const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) return { ok: false };
      // The chats survive (SetNull) — both lists refresh so Recent
      // re-honests itself immediately. A deleted draft must not
      // linger either.
      set((s) => ({
        draftProjectId: s.draftProjectId === id ? null : s.draftProjectId,
      }));
      await get().refreshProjects();
      await get().refreshChats();
      return { ok: true, releasedChats: data.releasedChats as number | undefined };
    } catch {
      return { ok: false };
    }
  },

  async moveChat(chatId, projectId) {
    try {
      const res = await fetch(`/api/chats/${chatId}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || "Move failed." };
      // Optimistic shape is unnecessary — both lists are small and
      // local; one round-trip keeps them exactly true.
      await Promise.all([get().refreshChats(), get().refreshProjects()]);
      return { ok: true };
    } catch {
      return { ok: false, error: "Move failed — network." };
    }
  },

  newChat: (projectId) =>
    // Every new chat resets to the default model (glm-5.3) —
    // the user can then switch freely for that conversation.
    // Run 37 — an explicit projectId (or null) sets the DRAFT
    // project the next send stamps onto the new chat; plain
    // "New chat" always clears it.
    set((s) => ({
      currentChatId: null,
      messages: [],
      pendingAttachments: [],
      galleryOpen: false,
      highlightMessageId: null,
      viewEpoch: s.viewEpoch + 1,
      draftProjectId: projectId ?? null,
      model: s.models.includes(DEFAULT_MODEL)
        ? DEFAULT_MODEL
        : s.models[0] ?? s.model,
    })),

  async selectChat(id) {
    if (get().streaming) return;
    // Re-clicking the chat you're already reading is a no-op —
    // no refetch, and no view-transition replay.
    if (get().currentChatId === id && !get().temporary) return;
    try {
      const res = await fetch(`/api/chats/${id}`);
      if (!res.ok) return;
      const chat = await res.json();
      set((s) => ({
        currentChatId: id,
        temporary: false,
        // Run 37 — entering a chat adopts ITS project context; the
        // draft only ever described a chat that didn't exist yet.
        draftProjectId: null,
        // Run 23 — entering a conversation always leaves the gallery.
        galleryOpen: false,
        // Run 26 — flash target arrives separately (flashMessage AFTER
        // the fetch resolves); a plain navigation never inherits one.
        highlightMessageId: null,
        // Run 22 guard: image chats store "image-forge" as their model
        // (honest in exports/search) but the composer may never ADOPT
        // it — a text follow-up would request a model the pool doesn't
        // have. Keep the session's real model instead.
        model:
          chat.model && chat.model !== "image-forge"
            ? chat.model
            : s.models.includes(DEFAULT_MODEL)
              ? DEFAULT_MODEL
              : s.model,
        // staged files belong to the previous conversation
        pendingAttachments: [],
        viewEpoch: s.viewEpoch + 1,
        messages: (chat.messages ?? []).map(
          (
            // Raw rows carry duel-runner-up columns (`altContent` /
            // `altModel`) that aren't part of UIMessage — read them
            // as unknown and narrow below. `variants` arrives already
            // parsed by the GET route.
            m: UIMessage & {
              altContent?: unknown;
              altModel?: unknown;
              variants?: unknown;
              variantIndex?: unknown;
              image?: unknown;
            }
          ) => ({
            ...m,
            sources: m.sources ?? null,
            attachments: m.attachments ?? null,
            // Duel runner-ups live on persisted messages (the winner
            // IS the message content/model).
            runnerUp:
              typeof m.altContent === "string" && m.altContent
                ? {
                    content: m.altContent,
                    model: typeof m.altModel === "string" ? m.altModel : "",
                  }
                : null,
            variants:
              Array.isArray(m.variants) && m.variants.length > 0
                ? (m.variants as AnswerVariant[])
                : null,
            variantIndex:
              typeof m.variantIndex === "number" ? m.variantIndex : null,
            // Run 22 — forged image reference (parsed by the GET route).
            image:
              m.image && typeof m.image === "object"
                ? (m.image as ImageRef)
                : null,
          })
        ),
      }));
    } catch {
      // non-fatal
    }
  },

  async deleteChat(id) {
    await fetch(`/api/chats/${id}`, { method: "DELETE" }).catch(() => {});
    if (get().currentChatId === id) {
      set((s) => ({
        currentChatId: null,
        messages: [],
        viewEpoch: s.viewEpoch + 1,
      }));
    }
    await get().refreshChats();
    // Run 23 — the gallery badge must not count a deleted chat's
    // images; re-ask the server for the honest number (fire-and-forget).
    if (!get().streaming) {
      void fetch("/api/images?count=1")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: unknown) => {
          const n = (d as { count?: unknown } | null)?.count;
          if (typeof n === "number") set({ imageCount: n });
        })
        .catch(() => {});
    }
    // Run 34 — deleting a chat cascades its ritual away (one owner,
    // zero orphans); re-sync the ritual list so the badge follows.
    if (!get().streaming) {
      void get().refreshRituals();
    }
  },

  async renameChat(id, title) {
    const t = title.trim().slice(0, 80);
    const prev = get().chats.find((c) => c.id === id);
    if (!t || !prev || prev.title === t) return true;
    // Optimistic: the new title appears instantly in the sidebar…
    set((s) => ({
      chats: s.chats.map((c) => (c.id === id ? { ...c, title: t } : c)),
    }));
    try {
      const res = await fetch(`/api/chats/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t }),
      });
      if (!res.ok) throw new Error("rename failed");
      return true;
    } catch {
      // …and rolls back to the server's truth if the write failed.
      await get().refreshChats();
      return false;
    }
  },

  async sendMessage(content) {
    const state = get();
    if (state.streaming || !content.trim()) return;
    // A duel still awaiting its pick? The primary lane becomes the
    // canonical answer so the next turn's history has one voice.
    const pending = [...state.messages].reverse().find((m) => m.duel && !m.duelPicked);
    if (pending) {
      await get().pickDuelWinner(pending.id, "a");
    }
    const s2 = get();
    const history: ChatMessageData[] = s2.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.role === "user" && m.attachments?.length
        ? { attachments: m.attachments }
        : {}),
    }));
    // Files staged in the composer: only READY records are sent (a
    // file that couldn't be read is never sent — the model must not
    // pretend it saw it). Failed/error chips stay for the user to
    // remove or ignore.
    const attachments = s2.pendingAttachments
      .filter((p) => p.status === "ready" && p.record)
      .map((p) => p.record!);
    const stillExtracting = s2.pendingAttachments.some(
      (p) => p.status === "extracting"
    );
    if (stillExtracting) return; // InputBar disables send meanwhile
    // Run 23 — sending while browsing the gallery returns to the
    // conversation so the streaming answer is actually visible.
    set({ pendingAttachments: [], galleryOpen: false });
    // Resolve the challenger at send time — the model list may have
    // changed since duel was armed.
    let challenger = s2.challenger;
    if (challenger === s2.model || !s2.models.includes(challenger ?? "")) {
      challenger = autoChallenger(s2.models, s2.model);
    }
    const duel =
      s2.duelEnabled && challenger ? { challenger } : undefined;
    // One-shot response style (/code, /concise) — armed by the slash
    // popover, consumed (and cleared) by THIS send.
    const style = s2.turnStyle ?? undefined;
    if (style) set({ turnStyle: null });
    await streamTurn(set, get, {
      chatId: s2.temporary ? null : s2.currentChatId,
      history,
      content,
      persistUser: true,
      duel,
      attachments,
      style,
      // Run 37 — a chat born now is stamped with the draft project.
      projectId: s2.temporary ? null : s2.draftProjectId,
    });
  },

  /** Run 22 — Image Forge send. Mirrors sendMessage's lifecycle:
   *  optimistic user bubble (badged as an image request), a live
   *  generating card (imagePending), abortable via Stop (the server
   *  discards the orphan file), error card with retry, and re-rolls
   *  that arrive with variant snapshots (earlier images kept). */
  async sendImage(prompt, opts) {
    const state = get();
    const text = prompt.trim();
    if (state.streaming || !text) return;
    // A duel still awaiting its pick? Resolve it first, exactly like
    // a text send (the turn history must have one voice).
    const pending = [...state.messages].reverse().find((m) => m.duel && !m.duelPicked);
    if (pending) {
      await get().pickDuelWinner(pending.id, "a");
    }
    const s2 = get();
    const temporary = s2.temporary;
    const size = opts?.size ?? s2.imageSize;
    const appendUserBubble = opts?.appendUserBubble !== false;
    const persistUser = opts?.persistUser !== false;
    const userId = `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const assistantId = `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Did this turn walk in WITHOUT a chat? (Then a successful forge
    // created one — its derived title deserves the refine pass.)
    const hadChat = s2.currentChatId != null;

    set({
      streaming: true,
      // Run 23 — a forge begun from the composer returns the view to
      // the conversation so the generating card is actually visible.
      galleryOpen: false,
      messages: [
        ...s2.messages,
        ...(appendUserBubble
          ? [
              {
                id: userId,
                role: "user" as const,
                content: text,
                imageRequest: { size },
              },
            ]
          : []),
        {
          id: assistantId,
          role: "assistant" as const,
          content: "",
          streaming: true,
          model: "image-forge",
          imagePending: true,
        },
      ],
    });

    const updateAssistant = (patch: Partial<UIMessage>) => {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === assistantId ? { ...m, ...patch } : m
        ),
      }));
    };

    const controller = new AbortController();
    streamController = controller;

    try {
      const res = await fetch("/api/image/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          chatId: temporary ? null : s2.currentChatId,
          prompt: text,
          size,
          temporary,
          persistUser,
          // Run 37 — a forge born now is stamped with the draft project.
          projectId: temporary ? null : s2.draftProjectId,
          ...(opts?.regenVariants?.length
            ? { regenVariants: opts.regenVariants }
            : {}),
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        let message = errText;
        try {
          message = (JSON.parse(errText) as { error?: string }).error ?? errText;
        } catch {
          // raw text fallback
        }
        throw new Error(message || `Image generation failed (${res.status})`);
      }
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        chatId?: string | null;
        userMessageId?: string | null;
        assistantMessageId?: string | null;
        content?: string;
        image?: ImageRef;
      };
      if (!data.ok || !data.image) {
        throw new Error(data.error || "Image generation failed.");
      }
      if (!temporary && typeof data.chatId === "string" && data.chatId) {
        set({ currentChatId: data.chatId });
      }
      // Run 23 — the gallery grows by exactly this forge (temp chats
      // never write DB rows, so they never join the gallery).
      if (!temporary) {
        set((s) => ({ imageCount: s.imageCount + 1 }));
      }
      // Re-roll: the fresh image joins the variant history (earlier
      // images first, the new one last + active) — nothing is lost.
      const regenVariants = opts?.regenVariants;
      const variants = regenVariants
        ? ([
            ...regenVariants,
            {
              content: data.content ?? "",
              model: "image-forge",
              tokens: 0,
              cached: false,
              servedBy: "zai-cloud",
              keyLabel: null,
              effort: null,
              image: data.image,
            },
          ] satisfies AnswerVariant[])
        : undefined;
      updateAssistant({
        id: data.assistantMessageId ?? assistantId,
        content: data.content ?? "",
        image: data.image,
        imagePending: false,
        streaming: false,
        model: "image-forge",
        provider: "Z.ai cloud",
        servedBy: "zai-cloud",
        tokens: 0,
        cached: false,
        phase: null,
        ...(variants
          ? { variants, variantIndex: regenVariants!.length }
          : {}),
      });
      // The user bubble gets its server id (edit/regen flows target it).
      if (appendUserBubble && data.userMessageId) {
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === userId ? { ...m, id: data.userMessageId! } : m
          ),
        }));
      }
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        // Stop pressed — like a stopped text turn, nothing survives.
        updateAssistant({
          streaming: false,
          imagePending: false,
          phase: null,
          error: "Image generation stopped.",
        });
      } else {
        updateAssistant({
          streaming: false,
          imagePending: false,
          phase: null,
          error: err.message || "Image generation failed.",
          content: "",
        });
      }
    } finally {
      streamController = null;
      set({ streaming: false });
      if (!temporary) {
        await get().refreshChats();
        if (!hadChat) {
          // A brand-new image chat — refine its derived title too.
          const freshId = get().currentChatId;
          if (freshId) void refineTitle(set, freshId);
        }
      }
      void get().refreshUsage();
    }
  },

  async editMessage(messageId, content) {
    const state = get();
    if (state.streaming || !content.trim()) return;
    const idx = state.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    if (state.temporary || !state.currentChatId) {
      // Local-only timeline: truncate everything after the edited message.
      const kept = state.messages
        .slice(0, idx + 1)
        .map((m) => (m.id === messageId ? { ...m, content: content.trim() } : m));
      set({ messages: kept });
      const history: ChatMessageData[] = kept.slice(0, -1).map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.role === "user" && m.attachments?.length
          ? { attachments: m.attachments }
          : {}),
      }));
      const edited = kept[kept.length - 1];
      await streamTurn(set, get, {
        chatId: null,
        history,
        content: content.trim(),
        persistUser: false,
        temporary: true,
        attachments: edited?.role === "user" ? edited.attachments ?? [] : [],
      });
      return;
    }

    const res = await fetch("/api/chat/fork", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId, content: content.trim() }),
    });
    const data = await res.json();
    if (!data.message) return;
    // Run 39 — THE FORK: the edit became a new sibling branch; the
    // original turn and its whole subtree stay in the database, one
    // ‹ › click away. The local timeline continues from the fork row.
    const fork = data.message as UIMessage;
    const kept: UIMessage[] = [
      ...state.messages.slice(0, idx),
      {
        ...fork,
        sources: fork.sources ?? null,
        attachments: fork.attachments ?? null,
      },
    ];
    set({ messages: kept });
    const history: ChatMessageData[] = kept.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.role === "user" && m.attachments?.length
        ? { attachments: m.attachments }
        : {}),
    }));
    const edited = kept[kept.length - 1];
    await streamTurn(set, get, {
      chatId: state.currentChatId,
      history,
      content: content.trim(),
      persistUser: false,
      attachments: edited?.role === "user" ? edited.attachments ?? [] : [],
    });
  },

  // Run 39 — THE FORK: move the displayed conversation to a sibling
  // branch at a fork point. The server re-resolves the active path
  // (leaf walk) and persists the choice in chat.activeLeafId, so a
  // reload keeps exactly the branch the user flipped to.
  async switchBranch(messageId, dir) {
    const s = get();
    if (s.streaming || s.temporary || !s.currentChatId) return;
    const msg = s.messages.find((m) => m.id === messageId);
    if (!msg?.siblingCount || msg.siblingCount < 2) return;
    const res = await fetch("/api/chat/branch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: s.currentChatId, messageId, dir }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data.messages)) return;
    set({
      messages: (data.messages as UIMessage[]).map((m) => ({
        ...m,
        sources: m.sources ?? null,
        attachments: m.attachments ?? null,
      })),
      highlightMessageId: null,
      // Run 39 — the flip wholesale-replaces the timeline; assistant
      // rows are slot-keyed (append-only contract), so a surviving
      // instance would keep the previous branch's typewriter state.
      // Bumping the view epoch remounts the reading surface fresh —
      // the same calm settle every navigation gets.
      viewEpoch: s.viewEpoch + 1,
    });
  },

  async retryLast(modelOverride) {
    const state = get();
    if (state.streaming) return;

    // The most recent failed assistant reply.
    let failedIdx = -1;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.role === "assistant" && m.error) {
        failedIdx = i;
        break;
      }
    }
    if (failedIdx === -1) return;

    // The user message that failed turn was answering.
    let userIdx = -1;
    for (let i = failedIdx - 1; i >= 0; i--) {
      if (state.messages[i].role === "user") {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return;
    const userMsg = state.messages[userIdx];

    // Run 22 — the failed turn was an Image Forge request: retry
    // re-forges the image (same prompt, same dimensions) instead of
    // streaming a text answer. The imageRequest flag lives on the
    // in-memory bubble — failed turns are never persisted, so no
    // server round-trip is needed to know this was an image turn.
    if (userMsg.imageRequest) {
      set({ messages: state.messages.slice(0, failedIdx) });
      await get().sendImage(userMsg.content, {
        appendUserBubble: false,
        persistUser: userMsg.id.startsWith("u-"),
        size: userMsg.imageRequest.size,
      });
      return;
    }

    const history: ChatMessageData[] = state.messages
      .slice(0, userIdx)
      .map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.role === "user" && m.attachments?.length
          ? { attachments: m.attachments }
          : {}),
      }));

    // Drop the failed bubble from the timeline.
    set({ messages: state.messages.slice(0, failedIdx) });

    // If the user message never received a server id, the turn died
    // before persistence — persist it on retry. Otherwise it is
    // already in the DB and must not be duplicated.
    const persisted = !userMsg.id.startsWith("u-");
    await streamTurn(set, get, {
      chatId: state.temporary ? null : state.currentChatId,
      history,
      content: userMsg.content,
      persistUser: !persisted,
      appendUserBubble: false, // the original user bubble stays
      temporary: state.temporary,
      model: modelOverride,
      // The retried turn sees the same files again.
      attachments: userMsg.attachments ?? [],
    });
  },

  /** Run 21 — REGENERATE: re-run the turn that produced the LAST
   *  assistant answer, snapshotting the current answer into the
   *  message's variant history first. The standard chat capability —
   *  a bad answer is one click from a better one, and every previous
   *  answer stays reachable (with its honest per-answer receipt). */
  async regenerate() {
    const state = get();
    if (state.streaming) return;
    const msgs = state.messages;
    // Regenerate only ever targets the timeline's last message, and
    // only when it's a settled, standalone assistant answer (errors
    // have their own Retry card; duels have their own lanes).
    const last = msgs[msgs.length - 1];
    if (
      !last ||
      last.role !== "assistant" ||
      last.streaming ||
      last.error ||
      last.duel ||
      last.runnerUp ||
      (!last.content.trim() && !last.image)
    ) {
      return;
    }
    // The user message that turn was answering.
    let userIdx = -1;
    for (let i = msgs.length - 2; i >= 0; i--) {
      if (msgs[i].role === "user") {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return;
    const userMsg = msgs[userIdx];

    // ── Run 22 — IMAGE RE-ROLL: the last answer is a forged image.
    // The current image is snapshotted into the variant history
    // (nothing is ever lost — re-rolls are the point of image gen),
    // the old row is truncated server-side, and the same prompt is
    // re-forged with the same dimensions. ──
    if (last.image) {
      const regenVariants: AnswerVariant[] = [
        ...(last.variants ?? []),
        {
          content: last.content,
          model: last.model ?? "image-forge",
          tokens: 0,
          cached: false,
          servedBy: last.servedBy ?? null,
          keyLabel: last.keyLabel ?? null,
          effort: last.effort ?? null,
          image: last.image,
        },
      ];
      const userPersisted = !userMsg.id.startsWith("u-");
      if (!state.temporary && state.currentChatId && userPersisted) {
        // Run 39 — THE FORK: nothing is deleted. The old image row
        // stays in the tree as a sibling branch; the leaf rewinds to
        // the user row so the re-forged image chains as its child.
        await fetch("/api/chat/leaf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: state.currentChatId, messageId: userMsg.id }),
        }).catch(() => {});
      }
      set({ messages: msgs.slice(0, userIdx + 1) });
      const size =
        userMsg.imageRequest?.size ??
        sizeFromDims(last.image.width, last.image.height) ??
        state.imageSize;
      await get().sendImage(userMsg.content, {
        appendUserBubble: false,
        persistUser: userMsg.id.startsWith("u-"),
        size,
        regenVariants,
      });
      return;
    }

    // Snapshot every earlier answer of this turn (existing variant
    // history + the current one), full provenance included.
    const regenVariants: AnswerVariant[] = [
      ...(last.variants ?? []),
      {
        content: last.content,
        model: last.model ?? "",
        tokens: last.tokens ?? 0,
        cached: Boolean(last.cached),
        servedBy: last.servedBy ?? null,
        keyLabel: last.keyLabel ?? null,
        effort: last.effort ?? null,
      },
    ];

    const history: ChatMessageData[] = msgs
      .slice(0, userIdx)
      .map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.role === "user" && m.attachments?.length
          ? { attachments: m.attachments }
          : {}),
      }));

    // Server-truth cleanup, FORK edition: the old answer row must not
    // stay the displayed leaf, or the re-streamed answer would chain
    // to IT instead of to the user's turn. The leaf rewinds to the
    // user row — the old answer stays in the tree as a sibling branch
    // (and lives on in the variant history too). Local-only turns
    // (temporary / never-persisted user bubble) skip.
    const userPersisted = !userMsg.id.startsWith("u-");
    if (!state.temporary && state.currentChatId && userPersisted) {
      await fetch("/api/chat/leaf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: state.currentChatId, messageId: userMsg.id }),
      }).catch(() => {});
    }

    // The old answer leaves the timeline; its snapshot travels into
    // the re-streamed turn and returns attached to the fresh reply.
    set({ messages: msgs.slice(0, userIdx + 1) });

    await streamTurn(set, get, {
      chatId: state.temporary ? null : state.currentChatId,
      history,
      content: userMsg.content,
      // The user bubble already exists (same rule as retryLast).
      persistUser: userMsg.id.startsWith("u-"),
      appendUserBubble: false,
      temporary: state.temporary,
      attachments: userMsg.attachments ?? [],
      regenVariants,
    });

    // Persist the variant set for saved chats (temporary turns stay
    // local-only, and an unpersisted turn has a local "a-" id).
    const s2 = get();
    const fresh = s2.messages[s2.messages.length - 1];
    if (
      !state.temporary &&
      fresh &&
      fresh.role === "assistant" &&
      fresh.variants &&
      !fresh.id.startsWith("a-")
    ) {
      void fetch("/api/chat/variant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId: fresh.id,
          variants: fresh.variants,
          variantIndex: fresh.variantIndex,
          content: fresh.content,
          model: fresh.model,
          tokens: fresh.tokens ?? 0,
          cached: Boolean(fresh.cached),
          servedBy: fresh.servedBy ?? null,
          keyLabel: fresh.keyLabel ?? null,
          effort: fresh.effort ?? null,
        }),
      }).catch(() => {});
    }
  },

  /** Run 21 — flip a message's active answer through its variant
   *  history (‹ 2/3 ›). The swapped-in answer carries its own
   *  provenance; saved chats get the new index persisted. */
  async navigateVariant(messageId, dir) {
    const s = get();
    if (s.streaming) return;
    const msg = s.messages.find((m) => m.id === messageId);
    if (!msg?.variants?.length || msg.variantIndex == null) return;
    const next = msg.variantIndex + dir;
    if (next < 0 || next >= msg.variants.length) return;
    const v = msg.variants[next];
    set({
      messages: s.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              variantIndex: next,
              content: v.content,
              model: v.model,
              tokens: v.tokens,
              cached: v.cached,
              servedBy: v.servedBy,
              keyLabel: v.keyLabel,
              effort: v.effort,
              // Image re-roll variants swap their image with the rest
              // of the receipt (Run 22) — text variants clear it.
              image: v.image ?? null,
            }
          : m
      ),
    });
    if (!s.temporary && !messageId.startsWith("a-")) {
      void fetch("/api/chat/variant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId,
          variants: msg.variants,
          variantIndex: next,
          content: v.content,
          model: v.model,
          tokens: v.tokens,
          cached: v.cached,
          servedBy: v.servedBy,
          keyLabel: v.keyLabel,
          effort: v.effort,
          image: v.image ?? null,
        }),
      }).catch(() => {});
    }
  },

  async pickDuelWinner(messageId, laneId) {
    const s = get();
    const msg = s.messages.find((m) => m.id === messageId);
    if (!msg?.duel || msg.duelPicked) return;
    const winner = msg.duel[laneId];
    const loser = msg.duel[laneId === "a" ? "b" : "a"];
    if (!winner.content.trim()) return; // nothing to keep
    const providerName = s.limiter?.providerName ?? null;

    // Local commit first — the pick must feel instant.
    set({
      messages: s.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              content: winner.content,
              model: winner.model,
              tokens: winner.tokens,
              cached: winner.cached,
              servedBy: winner.servedBy,
              keyLabel: winner.keyLabel,
              provider: providerName,
              duel: null,
              duelPicked: laneId,
              runnerUp: loser.content.trim()
                ? { content: loser.content, model: loser.model }
                : null,
              streaming: false,
              phase: null,
            }
          : m
      ),
    });

    // Persist for saved chats (temporary duels stay local-only).
    if (!s.temporary && s.currentChatId) {
      try {
        const res = await fetch("/api/chat/duel/pick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId: s.currentChatId,
            winner: {
              content: winner.content,
              model: winner.model,
              tokens: winner.tokens,
              cached: winner.cached,
              servedBy: winner.servedBy,
              keyLabel: winner.keyLabel,
            },
            runnerUp: loser.content.trim()
              ? { content: loser.content, model: loser.model }
              : null,
            effort: s.effort,
          }),
        });
        const data = (await res.json()) as { id?: string; error?: string };
        if (typeof data.id === "string" && data.id) {
          // Reconcile with the server id so later edits/truncates hit
          // the real message row.
          set((st) => ({
            messages: st.messages.map((m) =>
              m.id === messageId ? { ...m, id: data.id as string } : m
            ),
          }));
        }
      } catch {
        // keep the local pick — the answer stays in the timeline
      }
    }
  },

  stopStreaming: () => {
    streamController?.abort();
    streamController = null;
  },
}));

// ── SSE turn pipeline ─────────────────────────────────────────
type SetState = (
  partial: Partial<HermesState> | ((s: HermesState) => Partial<HermesState>)
) => void;
type GetState = () => HermesState;

interface TurnOptions {
  chatId: string | null;
  history: ChatMessageData[];
  content: string;
  persistUser: boolean;
  temporary?: boolean;
  /** Overrides the store's active model (error-card "switch model"). */
  model?: string;
  /** Force whether a new local user bubble is appended. Defaults to
      the persistUser flag — retries keep the original bubble but may
      still need server-side persistence, so the two are decoupled. */
  appendUserBubble?: boolean;
  /** Duel: race the active model against `duel.challenger`. */
  duel?: { challenger: string };
  /** Files the gateway already read for this turn. */
  attachments?: AttachmentRecord[];
  /** One-shot response style (/code, /concise) — normal turns only. */
  style?: TurnStyle;
  /** Run 37 — the project a NEW chat is born into (draft). The
   *  server only reads it when chatId is null. */
  projectId?: string | null;
  /** Regenerate: the earlier answers of this same turn. When set,
      the finalized message carries them as its variant history
      (the fresh answer is appended and made active). */
  regenVariants?: AnswerVariant[];
}

async function streamTurn(
  set: SetState,
  get: GetState,
  opts: TurnOptions
): Promise<void> {
  const state = get();
  const temporary = opts.temporary ?? state.temporary;
  const model = opts.model ?? state.model;
  const effort = state.effort;
  const userId = `u-${Date.now()}`;
  const assistantId = `a-${Date.now()}`;
  const search = state.searchEnabled;
  const duel = opts.duel;
  const attachments = opts.attachments ?? [];
  const makeLane = (id: "a" | "b", laneModel: string): DuelLane => ({
    id,
    model: laneModel,
    content: "",
    streaming: true,
    error: null,
    phase: search ? ("searching" as const) : ("thinking" as const),
    tokens: 0,
    cached: false,
    servedBy: null,
    keyLabel: null,
  });
  // Regenerate-after-edit turns keep the (already updated) user message
  // in the timeline — only fresh sends append a new local user bubble.
  // Retries decouple the two: the bubble stays, persistence is decided
  // by whether the failed turn ever reached the server.
  const appendUserBubble = opts.appendUserBubble ?? (opts.persistUser !== false);
  // Set when this turn creates a brand-new persisted chat — the
  // raw derived title then gets refined by a cheap model pass.
  let createdChatId: string | null = null;

  set({
    streaming: true,
    messages: [
      ...state.messages,
      ...(appendUserBubble
        ? [
            {
              id: userId,
              role: "user" as const,
              content: opts.content,
              sources: search ? [] : null,
              attachments: attachments.length ? attachments : null,
            },
          ]
        : []),
      {
        id: assistantId,
        role: "assistant" as const,
        content: "",
        streaming: true,
        model,
        provider: state.limiter?.providerName ?? null,
        phase: search ? "searching" : "thinking",
        effort,
        ...(duel
          ? {
              duel: {
                a: makeLane("a", model),
                b: makeLane("b", duel.challenger),
              },
              duelPicked: null,
            }
          : {}),
      },
    ],
  });

  const updateAssistant = (patch: Partial<UIMessage>) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === assistantId ? { ...m, ...patch } : m
      ),
    }));
  };
  // Duel-only: patch one racing lane of the assistant message.
  const updateLane = (lane: "a" | "b", patch: Partial<DuelLane>) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === assistantId && m.duel
          ? { ...m, duel: { ...m.duel, [lane]: { ...m.duel[lane], ...patch } } }
          : m
      ),
    }));
  };
  const updateUser = (patch: Partial<UIMessage>) => {
    set((s) => {
      const idx = appendUserBubble
        ? s.messages.findIndex((m) => m.id === currentUserMsgId)
        : (() => {
            for (let i = s.messages.length - 1; i >= 0; i--) {
              if (s.messages[i].role === "user") return i;
            }
            return -1;
          })();
      if (idx === -1) return {};
      return {
        messages: s.messages.map((m, i) => (i === idx ? { ...m, ...patch } : m)),
      };
    });
  };

  // ── Run 17: rAF-gated stream rendering ──
  // Deltas accumulate into these buffers SYNCHRONOUSLY (the data is
  // never delayed — only the render is), and the store is patched on
  // animation frames with a ≥32 ms floor so chunk bursts don't
  // re-render/re-parse the markdown tree per SSE event. Terminal
  // paths (done / error / Stop / stream end) flush or write
  // authoritative content, so the complete response is always shown
  // exactly once and Stop stays instant (flushNow is synchronous).
  let assistantContent = "";
  // Duel lanes accumulate independently; untagged deltas (normal
  // turns) fall through to assistantContent only.
  const laneContents: Record<"a" | "b", string> = { a: "", b: "" };
  const contentFlush = new StreamFlushScheduler(() =>
    updateAssistant({ content: assistantContent, phase: null })
  );
  const laneFlush: Record<"a" | "b", StreamFlushScheduler> = {
    a: new StreamFlushScheduler(() =>
      updateLane("a", { content: laneContents.a, phase: null })
    ),
    b: new StreamFlushScheduler(() =>
      updateLane("b", { content: laneContents.b, phase: null })
    ),
  };
  // True once a terminal event (done / error / abort) settled the
  // message — keeps the post-loop safety flush from ever writing
  // stale buffered content over server truth.
  let sawTerminal = false;

  const controller = new AbortController();
  streamController = controller;
  // Reconciled with the server-assigned id as soon as "meta" arrives so
  // later edits hit /api/chat/fork with the real message id.
  let currentUserMsgId = userId;

  try {
    const res = await fetch("/api/chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        chatId: opts.chatId,
        history: opts.history,
        content: opts.content,
        model,
        search,
        temporary,
        persistUser: opts.persistUser,
        effort,
        // Run 37 — names the project a NEW chat is born into; the
        // server re-derives from the chat row whenever chatId exists.
        projectId: opts.projectId ?? null,
        ...(attachments.length ? { attachments } : {}),
        ...(duel ? { duel: true, challengerModel: duel.challenger } : {}),
        ...(opts.style ? { style: opts.style } : {}),
      }),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      throw new Error(errText || `Request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (ev.type === "meta") {
          if (!temporary && typeof ev.chatId === "string" && ev.chatId) {
            set({ currentChatId: ev.chatId });
            if (opts.chatId == null) createdChatId = ev.chatId;
          }
          // The effort dial may route the turn to a different pooled
          // engine (fast → flash tier, deep → frontier tier) — the
          // server's model is the truth the provenance must show.
          if (typeof ev.model === "string" && ev.model) {
            updateAssistant({ model: ev.model });
          }
          if (
            typeof ev.userMessageId === "string" &&
            ev.userMessageId &&
            appendUserBubble
          ) {
            const serverId = ev.userMessageId;
            // patch FIRST (message still carries the local id), then move
            // the cursor so later patches (sources, …) target the new id
            updateUser({ id: serverId });
            currentUserMsgId = serverId;
          }
        } else if (ev.type === "duel_start") {
          // Reconcile lane models with the server's normalization.
          if (duel) {
            if (typeof ev.a === "string" && ev.a) updateLane("a", { model: ev.a });
            if (typeof ev.b === "string" && ev.b) updateLane("b", { model: ev.b });
          }
        } else if (ev.type === "search_status") {
          const status = String(ev.status ?? "");
          const detail =
            typeof ev.detail === "string" && ev.detail ? ev.detail : null;
          if (status === "searching") {
            updateAssistant({ phase: "searching", searchDetail: detail });
            if (duel) {
              updateLane("a", { phase: "searching" });
              updateLane("b", { phase: "searching" });
            }
          } else if (status === "ok") {
            updateAssistant({ phase: "thinking", searchFailed: false, searchDetail: null });
            if (duel) {
              updateLane("a", { phase: "thinking" });
              updateLane("b", { phase: "thinking" });
            }
          } else if (status === "failed") {
            updateAssistant({ phase: "thinking", searchFailed: true, searchDetail: null });
            if (duel) {
              updateLane("a", { phase: "thinking" });
              updateLane("b", { phase: "thinking" });
            }
          }
        } else if (ev.type === "sources") {
          const sources = (ev.sources ?? []) as SearchSource[];
          if (sources.length) updateUser({ sources });
        } else if (ev.type === "restart") {
          // A provider died mid-stream; the cloud re-generates that
          // lane from scratch. Discard only the affected lane's
          // partial text (untagged = normal single-lane turn). The
          // scheduled frame is cancelled FIRST so no stale buffered
          // content flashes back after the reset.
          const lane = ev.lane === "b" ? "b" : "a";
          if (duel) {
            laneFlush[lane].cancel();
            laneContents[lane] = "";
            updateLane(lane, { content: "", phase: "thinking" });
          } else {
            contentFlush.cancel();
            assistantContent = "";
            updateAssistant({ content: "", phase: "thinking" });
          }
        } else if (ev.type === "delta") {
          const lane = ev.lane === "b" ? "b" : "a";
          if (duel) {
            laneContents[lane] += String(ev.text ?? "");
            laneFlush[lane].notify();
          } else {
            assistantContent += String(ev.text ?? "");
            contentFlush.notify();
          }
        } else if (ev.type === "lane_done") {
          // Final per-lane stats from the gateway — server truth wins.
          const lane = ev.lane === "b" ? "b" : "a";
          if (duel) {
            // Server truth supersedes the buffer — drop any pending
            // frame before writing it.
            laneFlush[lane].cancel();
            updateLane(lane, {
              content: (ev.content as string) ?? laneContents[lane],
              streaming: false,
              phase: null,
              tokens: (ev.tokens as number) ?? 0,
              cached: ev.cached === true,
              servedBy: (ev.servedBy as string) ?? null,
              keyLabel: (ev.keyLabel as string) ?? null,
              error: (ev.error as string) ?? null,
            });
          }
        } else if (ev.type === "done") {
          if (duel && ev.duel && typeof ev.duel === "object") {
            sawTerminal = true;
            laneFlush.a.cancel();
            laneFlush.b.cancel();
            const lanes = ev.duel as {
              a: { content: string; error: string | null; tokens: number; cached: boolean; servedBy: string | null; keyLabel: string | null; model: string };
              b: { content: string; error: string | null; tokens: number; cached: boolean; servedBy: string | null; keyLabel: string | null; model: string };
            };
            updateAssistant({
              streaming: false,
              phase: null,
              searchFailed: ev.searchFailed === true,
            });
            updateLane("a", {
              content: lanes.a.content,
              model: lanes.a.model,
              streaming: false,
              phase: null,
              tokens: lanes.a.tokens,
              cached: lanes.a.cached,
              servedBy: lanes.a.servedBy,
              keyLabel: lanes.a.keyLabel,
              error: lanes.a.error,
            });
            updateLane("b", {
              content: lanes.b.content,
              model: lanes.b.model,
              streaming: false,
              phase: null,
              tokens: lanes.b.tokens,
              cached: lanes.b.cached,
              servedBy: lanes.b.servedBy,
              keyLabel: lanes.b.keyLabel,
              error: lanes.b.error,
            });
            // One lane died → the duel silently degrades: keep the
            // surviving lane as the answer (no pick needed).
            if (lanes.a.error && !lanes.b.error && lanes.b.content.trim()) {
              void get().pickDuelWinner(assistantId, "b");
            } else if (lanes.b.error && !lanes.a.error && lanes.a.content.trim()) {
              void get().pickDuelWinner(assistantId, "a");
            }
            // Both lanes healthy → the message waits for the user's pick.
          } else {
            sawTerminal = true;
            // The done event carries the authoritative full content
            // (fallback: the buffer) — cancel the pending frame so a
            // stale flush can never follow this write.
            contentFlush.cancel();
            const finalContent = (ev.content as string) ?? assistantContent;
            const finalModel = (ev.model as string) ?? model;
            // Regenerate: the fresh answer joins the variant history
            // (previous answers first, new one last + active).
            const variants = opts.regenVariants
              ? ([
                  ...opts.regenVariants,
                  {
                    content: finalContent,
                    model: finalModel,
                    tokens: (ev.tokens as number) ?? 0,
                    cached: ev.cached === true,
                    servedBy: (ev.servedBy as string) ?? null,
                    keyLabel: (ev.keyLabel as string) ?? null,
                    effort:
                      ev.effort === "fast" || ev.effort === "deep" || ev.effort === "medium"
                        ? ev.effort
                        : effort,
                  },
                ] satisfies AnswerVariant[])
              : undefined;
            updateAssistant({
              id: (ev.assistantMessageId as string) ?? assistantId,
              content: finalContent,
              streaming: false,
              cached: Boolean(ev.cached),
              tokens: (ev.tokens as number) ?? 0,
              tokensEstimated: ev.tokensEstimated === true,
              servedBy: (ev.servedBy as string) ?? null,
              keyLabel: (ev.keyLabel as string) ?? null,
              provider: (ev.providerName as string) ?? null,
              model: finalModel,
              effort:
                ev.effort === "fast" || ev.effort === "deep" || ev.effort === "medium"
                  ? ev.effort
                  : effort,
              phase: null,
              searchDetail: null,
              searchFailed: ev.searchFailed === true,
              ...(variants
                ? { variants, variantIndex: opts.regenVariants!.length }
                : {}),
            });
          }
        } else if (ev.type === "error") {
          sawTerminal = true;
          contentFlush.cancel();
          laneFlush.a.cancel();
          laneFlush.b.cancel();
          updateAssistant({
            streaming: false,
            error: String(ev.message ?? "Generation failed"),
            content: "",
            phase: null,
          });
        }
      }
    }

    // The stream ended WITHOUT a terminal event (server closed
    // early). Flush whatever is still buffered so the tail tokens
    // are never lost, and settle the message — no caret may spin
    // forever.
    if (!sawTerminal) {
      contentFlush.flushNow();
      laneFlush.a.flushNow();
      laneFlush.b.flushNow();
      updateAssistant({ streaming: false, phase: null });
      if (duel) {
        updateLane("a", { streaming: false, phase: null });
        updateLane("b", { streaming: false, phase: null });
      }
    }
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      // User pressed stop — the partial text must appear INSTANTLY:
      // flushNow is synchronous, so throttling never delays Stop.
      sawTerminal = true;
      if (duel) {
        laneFlush.a.flushNow();
        laneFlush.b.flushNow();
        // A stopped duel keeps both partial lanes — the user can
        // still pick either one as the answer.
        updateAssistant({ streaming: false, phase: null });
        updateLane("a", { streaming: false, phase: null });
        updateLane("b", { streaming: false, phase: null });
      } else {
        contentFlush.flushNow();
        updateAssistant({ streaming: false, phase: null });
      }
    } else {
      sawTerminal = true;
      contentFlush.cancel();
      laneFlush.a.cancel();
      laneFlush.b.cancel();
      updateAssistant({
        streaming: false,
        error: err.message,
        content: "",
        phase: null,
      });
    }
  } finally {
    // Last-resort cleanup: no scheduled animation frame may outlive
    // the turn (the store-level equivalent of unmount cleanup).
    contentFlush.cancel();
    laneFlush.a.cancel();
    laneFlush.b.cancel();
    streamController = null;
    set({ streaming: false });
    if (!temporary) {
      // Await the refresh so the raw derived title is in the list
      // BEFORE the refined one patches it (no clobber race).
      await get().refreshChats();
      // Run 37 — a chat born inside a project just landed in the
      // sidebar's nested list; the project's chatCount follows.
      if (opts.projectId) void get().refreshProjects();
      if (createdChatId) void refineTitle(set, createdChatId);
    }
    void get().refreshUsage();
  }
}

/**
 * Replace a brand-new chat's raw derived title ("who r u?") with a
 * proper one from a cheap cloud model pass: "Who Are You?". Fire and
 * forget — failure keeps the derived title.
 */
async function refineTitle(set: SetState, chatId: string): Promise<void> {
  try {
    const res = await fetch("/api/chat/title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId }),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { title?: string };
    const title = typeof data.title === "string" ? data.title.trim() : "";
    if (!title) return;
    set((s) => ({
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, title } : c)),
    }));
  } catch {
    // keep the derived title
  }
}
