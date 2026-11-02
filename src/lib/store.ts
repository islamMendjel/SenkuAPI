"use client";

// SenkuAPI — client store (Zustand). Owns bootstrap data, chat state
// and the SSE streaming turn pipeline.

import { create } from "zustand";
import { DEFAULT_MODEL } from "@/lib/senku/constants";
import { countLines } from "@/lib/senku/format";
import { autoChallenger } from "@/lib/senku/models";
import { StreamFlushScheduler } from "@/lib/senku/raf-throttle";
import type {
  AttachmentRecord,
  ChatMessageData,
  EffortLevel,
  LimiterStatus,
  ProviderView,
  SearchSource,
  TurnStyle,
} from "@/lib/senku/types";

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

/** A code block staged into the Senku Canvas (the Tools aside).
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
}

export interface ChatListItem {
  id: string;
  title: string;
  model: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
}

interface UserInfo {
  name: string;
  email: string;
  plan: string;
}

interface SenkuState {
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

  /** Run 17 — Senku Canvas state (the Tools aside). The source is
   *  kept across close/reopen so the user never loses a preview. */
  canvasOpen: boolean;
  canvasSource: CanvasSource | null;
  openCanvas: (src: CanvasSource) => void;
  closeCanvas: () => void;
  setCanvasOpen: (open: boolean) => void;

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

  newChat: () => void;
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
    void useSenku.getState().refreshUsage();
  }, delay);
}

function applyProviderView(
  providers: ProviderView[],
  view: ProviderView
): ProviderView[] {
  return providers.map((p) => (p.id === view.id ? view : p));
}

export const useSenku = create<SenkuState>((set, get) => ({
  user: {
    name: "senku",
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

  currentChatId: null,
  messages: [],
  streaming: false,
  booted: false,
  viewEpoch: 0,
  pendingAttachments: [],
  turnStyle: null,
  canvasOpen: false,
  canvasSource: null,

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
  toggleSearch: () => set((s) => ({ searchEnabled: !s.searchEnabled })),
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
      set({ duelEnabled: true, challenger });
    } else {
      set({ duelEnabled: false });
    }
  },
  setChallenger: (m) => set({ challenger: m }),
  setEffort: (e) => set({ effort: e }),

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

  newChat: () =>
    // Every new chat resets to the default model (glm-5.3) —
    // the user can then switch freely for that conversation.
    set((s) => ({
      currentChatId: null,
      messages: [],
      pendingAttachments: [],
      viewEpoch: s.viewEpoch + 1,
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
        model: chat.model ?? s.model,
        // staged files belong to the previous conversation
        pendingAttachments: [],
        viewEpoch: s.viewEpoch + 1,
        messages: (chat.messages ?? []).map((m: UIMessage) => ({
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
        })),
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
    set({ pendingAttachments: [] });
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
    });
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

    const res = await fetch("/api/chat/truncate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId, content: content.trim() }),
    });
    const data = await res.json();
    if (!Array.isArray(data.messages)) return;
    const kept: UIMessage[] = data.messages.map((m: UIMessage) => ({
      ...m,
      sources: m.sources ?? null,
      attachments: m.attachments ?? null,
    }));
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
  partial: Partial<SenkuState> | ((s: SenkuState) => Partial<SenkuState>)
) => void;
type GetState = () => SenkuState;

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
  // later edits hit /api/chat/truncate with the real message id.
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
            updateAssistant({
              id: (ev.assistantMessageId as string) ?? assistantId,
              content: (ev.content as string) ?? assistantContent,
              streaming: false,
              cached: Boolean(ev.cached),
              tokens: (ev.tokens as number) ?? 0,
              tokensEstimated: ev.tokensEstimated === true,
              servedBy: (ev.servedBy as string) ?? null,
              keyLabel: (ev.keyLabel as string) ?? null,
              provider: (ev.providerName as string) ?? null,
              model: (ev.model as string) ?? model,
              effort:
                ev.effort === "fast" || ev.effort === "deep" || ev.effort === "medium"
                  ? ev.effort
                  : effort,
              phase: null,
              searchDetail: null,
              searchFailed: ev.searchFailed === true,
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
