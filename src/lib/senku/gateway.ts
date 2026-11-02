// SenkuAPI — gateway pipeline (equivalent of main.py + router.py).
// One chat turn: seed → active provider → web search (optional) →
// exact-match cache → health-aware key dispatch (pool retry) →
// cloud completion → usage accounting → cache fill → persistence.

import { db } from "@/lib/db";
import { computeCacheKey, getCached, putCached } from "./cache";
import {
  attachmentContextBlock,
  sanitizeAttachments,
} from "./attachments";
import {
  BASE_SYSTEM_PROMPT,
  DEEP_RESEARCH_ADDON,
  DEEP_THINKING_ADDON,
  FAST_SYSTEM_ADDON,
  SEARCH_SYSTEM_DIRECTIVE,
  liveContextBlock,
  liveContextBlockHourStable,
  searchContextBlock,
} from "./constants";
import { dispatchCompletion } from "./dispatch";
import { appendConfidenceLabel, estimateTokens, revealWords } from "./executor";
import { confidenceOf } from "./grounding";
import { effortModel } from "./models";
import { getActiveProvider } from "./router";
import { deepSearchDetailed, webSearchDetailed } from "./search";
import type {
  AttachmentRecord,
  ChatMessageData,
  EffortLevel,
  SearchSource,
} from "./types";

export interface TurnEvent {
  type:
    | "meta"
    | "search_status"
    | "sources"
    | "delta"
    | "restart"
    | "duel_start"
    | "lane_done"
    | "done"
    | "error";
  [k: string]: unknown;
}

export interface TurnParams {
  chatId?: string | null;
  history: ChatMessageData[]; // prior turns (already persisted)
  content: string; // new user message
  model: string;
  search: boolean;
  temporary: boolean; // temporary chats are never persisted
  persistUser?: boolean; // false when regenerating after an edit (message already updated)
  /** Effort dial. "medium" (default) = byte-identical legacy
   *  behavior; "fast" routes to the fastest pooled engine with a
   *  brevity directive; "deep" routes to the strongest pooled
   *  engine with thinking + multi-round audited retrieval. */
  effort?: EffortLevel;
  /** Files the gateway ALREADY read (extraction happened at pick
   *  time). Their text is appended to the request context — never
   *  to the stored message content — and persisted on the user
   *  message row so follow-up turns and reloads keep the context. */
  attachments?: AttachmentRecord[];
  emit: (ev: TurnEvent) => void;
}

export interface TurnResult {
  chatId: string | null;
  userMessageId: string | null;
  assistantMessageId: string | null;
  title: string | null;
  sources: SearchSource[];
  content: string;
  cached: boolean;
  tokens: number; // effective (multiplied) tokens billed — 0 when cached
  rawTokens: number;
  servedBy: "provider" | "zai-cloud" | "cache";
  keyLabel: string | null;
  providerName: string;
  model: string;
  /** which effort level served this turn */
  effort: EffortLevel;
  /** true when search was requested but every engine failed */
  searchFailed: boolean;
}

function deriveTitle(content: string): string {
  const clean = content
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ?!.,'’-]/gu, "")
    .trim();
  const words = clean.split(" ").filter(Boolean).slice(0, 6).join(" ");
  return (words || "New chat").slice(0, 60);
}

function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** History rows keep their attachment extracts — a follow-up
 *  question ("what was the revenue figure?") must still see the
 *  file from the earlier turn, exactly like the incumbents. */
function expandHistory(history: ChatMessageData[]): ChatMessageData[] {
  return history.map((m) =>
    m.role === "user" && m.attachments?.length
      ? { ...m, content: m.content + attachmentContextBlock(m.attachments) }
      : m
  );
}

export async function runChatTurn(params: TurnParams): Promise<TurnResult> {
  const { emit } = params;
  const provider = await getActiveProvider();
  const providerModels = JSON.parse(provider.models || "[]") as string[];
  const requestedModel =
    params.model || providerModels[0] || "free/glm-5.3";
  const effort: EffortLevel = params.effort ?? "medium";
  // The effort dial routes across the POOL: fast → the fastest
  // engine the provider offers, deep → the strongest. Medium keeps
  // the user's selection untouched (legacy behavior).
  const model = effortModel(providerModels, requestedModel, effort);
  // Untrusted client payload — rebuilt field-by-field server-side.
  const attachments = sanitizeAttachments(params.attachments);

  // ── 1. Web search ──
  // Medium/fast: strict discipline (≤3 snippets, ≤300 chars), one
  // pass. Deep: multi-round iterative retrieval — plan queries,
  // search the question verbatim, then the planned angles in
  // parallel, merged URL-deduped (≤8 sources), with live stage
  // labels streamed to the client.
  let sources: SearchSource[] = [];
  let searchEngine: string | undefined;
  if (params.search) {
    if (effort === "deep") {
      emit({ type: "search_status", status: "searching", depth: "deep" });
      const outcome = await deepSearchDetailed(params.content, (detail) =>
        emit({ type: "search_status", status: "searching", detail, depth: "deep" })
      );
      sources = outcome.results;
      searchEngine = "deep";
    } else {
      emit({ type: "search_status", status: "searching" });
      const outcome = await webSearchDetailed(params.content);
      sources = outcome.results;
      searchEngine = outcome.source;
    }
    emit({ type: "sources", sources });
    emit({
      type: "search_status",
      status: sources.length ? "ok" : "failed",
      engine: searchEngine,
      depth: effort === "deep" ? "deep" : undefined,
    });
  }

  // Effort directives append AFTER the base contract. Medium adds
  // NOTHING — the prompt stays byte-identical to pre-dial turns so
  // the 24h response cache still hits. Fast/deep additions also
  // namespace the cache key per effort level for free.
  const effortAddon =
    effort === "fast"
      ? FAST_SYSTEM_ADDON
      : effort === "deep"
        ? sources.length
          ? DEEP_RESEARCH_ADDON
          : DEEP_THINKING_ADDON
        : "";
  const baseSystemPrompt =
    (params.search && sources.length ? SEARCH_SYSTEM_DIRECTIVE : BASE_SYSTEM_PROMPT) +
    (effortAddon ? `\n\n${effortAddon}` : "");
  // The model always knows the real "now" (user's timezone).
  const systemPrompt = `${baseSystemPrompt}\n\n${liveContextBlock()}`;

  const finalUserContent =
    params.content +
    attachmentContextBlock(attachments) +
    (sources.length ? searchContextBlock(sources) : "");

  // ── 2. Exact-match cache (prompt + model + hour-stable system prompt) ──
  // The clock block is hour-stable here so repeat questions within the
  // same hour still hit the cache, while the model sees second-level time.
  const cacheKey = computeCacheKey(
    finalUserContent,
    model,
    `${baseSystemPrompt}\n\n${liveContextBlockHourStable()}`
  );
  const cached = await getCached(cacheKey);

  // ── 3. Persistence: chat row + user message ──
  let chatId = params.chatId ?? null;
  let userMessageId: string | null = null;
  let title: string | null = null;

  if (!params.temporary && params.persistUser !== false) {
    if (!chatId) {
      title = deriveTitle(params.content);
      const chat = await db.chat.create({
        data: {
          title,
          model,
          provider: provider.name,
          isTemporary: false,
        },
      });
      chatId = chat.id;
    }
    const userMsg = await db.message.create({
      data: {
        chatId,
        role: "user",
        content: params.content,
        sources: sources.length ? JSON.stringify(sources) : null,
        attachments: attachments.length ? JSON.stringify(attachments) : null,
      },
    });
    userMessageId = userMsg.id;
  } else if (!params.temporary && params.chatId) {
    chatId = params.chatId;
  }

  emit({
    type: "meta",
    chatId,
    userMessageId,
    title,
    provider: provider.name,
    model,
    effort,
  });

  // ── 4a. Cache hit → 0 tokens spent ──
  if (cached) {
    // Contract enforcement applies to cached search answers too
    // (older cache entries may predate the confidence-label rule).
    if (sources.length && !confidenceOf(cached.content)) {
      cached.content = await appendConfidenceLabel(cached.content);
    }
    // Cached answers type out live too — the answer never appears
    // in a single shot, even when it cost 0 tokens.
    await revealWords(cached.content, (text) => emit({ type: "delta", text }));
    let assistantMessageId: string | null = null;
    if (!params.temporary && chatId) {
      const msg = await db.message.create({
        data: {
          chatId,
          role: "assistant",
          content: cached.content,
          model,
          provider: provider.name,
          keyLabel: "cache",
          tokens: 0,
          cached: true,
        },
      });
      assistantMessageId = msg.id;
      await db.chat.update({
        where: { id: chatId },
        data: { updatedAt: new Date(), model, provider: provider.name },
      });
    }
    // Audit trail: cached hit, zero tokens.
    await db.usageEvent.create({
      data: {
        keyId: null,
        providerId: provider.id,
        chatId,
        model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        multiplier: provider.tokenMultiplier,
        cached: true,
      },
    });
    const done = {
      type: "done",
      chatId,
      assistantMessageId,
      content: cached.content,
      cached: true,
      tokens: 0,
      rawTokens: 0,
      servedBy: "cache" as const,
      keyLabel: "cache",
      providerName: provider.name,
      model,
      effort,
      sources,
      searchFailed: params.search && sources.length === 0,
    };
    emit(done);
    return done;
  }

  // ── 4b + 5. Health-aware key dispatch, then cloud completion ──
  // The dispatcher round-robins pooled keys, quarantines dead ones
  // (auth failures), retries the next healthy key within the same
  // turn, and only fails over to the Z.ai cloud when every key
  // failed. Hard pool errors (no keys / limiter exhaustion) keep
  // their original coded messages.
  const messages: ChatMessageData[] = [
    { role: "system", content: systemPrompt },
    ...expandHistory(params.history).slice(-20),
    { role: "user", content: finalUserContent },
  ];

  const routed = await dispatchCompletion({
    provider,
    model,
    messages,
    onDelta: (text) => emit({ type: "delta", text }),
    // Mid-stream provider death → the cloud re-emits from scratch;
    // "restart" tells the client to clear the partial text first.
    onRestart: () => emit({ type: "restart" }),
    // Deep effort → the cloud failover THINKS before answering.
    thinking: effort === "deep",
  });
  const exec = routed.exec;
  // The key that actually served — null when the Z.ai cloud did.
  const key = routed.key;

  // ── Grounded-answer contract enforcement ──
  // On search turns the confidence label is mandatory. The directive
  // asks for it, but model compliance is probabilistic — when the
  // answer lacks the label, one cheap corrective pass appends it so
  // the contract holds deterministically (cache fills afterwards,
  // so corrected answers are reused corrected).
  if (sources.length && !confidenceOf(exec.content)) {
    exec.content = await appendConfidenceLabel(exec.content);
  }

  // ── 6. Usage accounting (multiplier applies to effective totals) ──
  // Only the key that ACTUALLY served the response is billed — a
  // dead key that failed over to the cloud never gets charged.
  const rawTotal =
    exec.totalTokens ||
    exec.promptTokens + exec.completionTokens ||
    estimateTokens(finalUserContent) + estimateTokens(exec.content);

  await db.usageEvent.create({
    data: {
      keyId: key?.id ?? null,
      providerId: provider.id,
      chatId,
      model,
      promptTokens: exec.promptTokens,
      completionTokens: exec.completionTokens,
      totalTokens: rawTotal,
      multiplier: provider.tokenMultiplier,
      cached: false,
    },
  });

  // Roll the serving key's monthly accumulator forward (monthKey
  // flip safe). Skipped entirely on cloud failover — no key served.
  if (key) {
    const now = new Date();
    const mk = monthKey(now);
    const monthAgg = await db.usageEvent.aggregate({
      _sum: { totalTokens: true },
      where: {
        keyId: key.id,
        createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), 1) },
      },
    });
    await db.apiKey.update({
      where: { id: key.id },
      data: {
        lastUsedAt: now,
        monthKey: mk,
        tokensUsedThisMonth: monthAgg._sum.totalTokens ?? rawTotal,
      },
    });
  }

  // ── 7. Cache fill (24h TTL) ──
  await putCached({
    cacheKey,
    model,
    provider: provider.name,
    content: exec.content,
    tokens: rawTotal,
  });

  // ── 8. Persist assistant message ──
  // keyLabel is only recorded when a pooled key actually served the
  // response — a cloud-failover answer never claims a key it didn't use.
  const effectiveTokens = Math.round(rawTotal * provider.tokenMultiplier);
  const servedKeyLabel = key?.label ?? null;
  let assistantMessageId: string | null = null;
  if (!params.temporary && chatId) {
    const msg = await db.message.create({
      data: {
        chatId,
        role: "assistant",
        content: exec.content,
        model,
        provider: provider.name,
        keyLabel: servedKeyLabel,
        tokens: effectiveTokens,
        cached: false,
        effort,
      },
    });
    assistantMessageId = msg.id;
    await db.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date(), model, provider: provider.name },
    });
  }

  const done: TurnResult = {
    chatId,
    userMessageId,
    assistantMessageId,
    title,
    sources,
    content: exec.content,
    cached: false,
    tokens: effectiveTokens,
    rawTokens: rawTotal,
    servedBy: exec.servedBy,
    keyLabel: servedKeyLabel,
    providerName: provider.name,
    model,
    effort,
    searchFailed: params.search && sources.length === 0,
  };
  emit({ type: "done", ...done });
  return done;
}

// ── Duel turn ─────────────────────────────────────────────────
// TWO models race in parallel on one question: shared web search,
// shared chat + user-message persistence, per-lane cache lookup,
// health-aware dispatch, grounded-contract enforcement, usage
// accounting and cache fill. Both lanes are billed honestly for
// what they actually served. The WINNER is not persisted here —
// the client calls POST /api/chat/duel/pick once the user chooses;
// that endpoint stores the winner as the assistant message and the
// loser as its runner-up reference.

export interface DuelLaneResult {
  lane: "a" | "b";
  model: string;
  content: string;
  tokens: number; // effective (multiplied) tokens billed — 0 when cached
  rawTokens: number;
  cached: boolean;
  servedBy: "provider" | "zai-cloud" | "cache" | null; // null on error
  keyLabel: string | null;
  error: string | null;
}

export interface DuelParams {
  chatId?: string | null;
  history: ChatMessageData[];
  content: string;
  model: string; // lane A — the user's selected model
  challenger: string; // lane B
  search: boolean;
  temporary: boolean;
  persistUser?: boolean;
  /** Effort affects the duel's SHARED retrieval (deep → multi-round
   *  search + thinking on the cloud path) but never the lane models
   *  — a duel is explicitly about the two engines the user chose. */
  effort?: EffortLevel;
  /** Files the gateway read — shared by both lanes (the same
   *  material, the same rules as a normal turn). */
  attachments?: AttachmentRecord[];
  emit: (ev: TurnEvent) => void;
}

export interface DuelTurnResult {
  chatId: string | null;
  userMessageId: string | null;
  title: string | null;
  sources: SearchSource[];
  lanes: { a: DuelLaneResult; b: DuelLaneResult };
  bothFailed: boolean;
}

export async function runDuelTurn(
  params: DuelParams
): Promise<DuelTurnResult> {
  const { emit } = params;
  const provider = await getActiveProvider();
  const providerModels = JSON.parse(provider.models || "[]") as string[];
  const modelA = params.model || providerModels[0] || "free/glm-5.3";
  const modelB = params.challenger;
  const effort: EffortLevel = params.effort ?? "medium";
  const attachments = sanitizeAttachments(params.attachments);

  if (!modelB || modelB === modelA) {
    throw new Error("Duel needs two different models");
  }
  if (
    providerModels.length &&
    (!providerModels.includes(modelA) || !providerModels.includes(modelB))
  ) {
    throw new Error("Both duel models must be available on the active provider");
  }

  // ── 1. Shared web search — both lanes reason from the SAME retrieval ──
  let sources: SearchSource[] = [];
  if (params.search) {
    if (effort === "deep") {
      emit({ type: "search_status", status: "searching", depth: "deep" });
      const outcome = await deepSearchDetailed(params.content, (detail) =>
        emit({ type: "search_status", status: "searching", detail, depth: "deep" })
      );
      sources = outcome.results;
    } else {
      emit({ type: "search_status", status: "searching" });
      const outcome = await webSearchDetailed(params.content);
      sources = outcome.results;
    }
    emit({ type: "sources", sources });
    emit({
      type: "search_status",
      status: sources.length ? "ok" : "failed",
      depth: effort === "deep" ? "deep" : undefined,
    });
  }

  const baseSystemPrompt =
    params.search && sources.length ? SEARCH_SYSTEM_DIRECTIVE : BASE_SYSTEM_PROMPT;
  const systemPrompt = `${baseSystemPrompt}\n\n${liveContextBlock()}`;
  const finalUserContent =
    params.content +
    attachmentContextBlock(attachments) +
    (sources.length ? searchContextBlock(sources) : "");

  // ── 2. Shared persistence: chat row + user message (same as a
  //      normal turn — the winner is appended later, at pick time) ──
  let chatId = params.chatId ?? null;
  let userMessageId: string | null = null;
  let title: string | null = null;

  if (!params.temporary && params.persistUser !== false) {
    if (!chatId) {
      title = deriveTitle(params.content);
      const chat = await db.chat.create({
        data: {
          title,
          model: modelA,
          provider: provider.name,
          isTemporary: false,
        },
      });
      chatId = chat.id;
    }
    const userMsg = await db.message.create({
      data: {
        chatId,
        role: "user",
        content: params.content,
        sources: sources.length ? JSON.stringify(sources) : null,
        attachments: attachments.length ? JSON.stringify(attachments) : null,
      },
    });
    userMessageId = userMsg.id;
  } else if (!params.temporary && params.chatId) {
    chatId = params.chatId;
  }

  emit({
    type: "meta",
    chatId,
    userMessageId,
    title,
    provider: provider.name,
    model: modelA,
    effort,
  });
  emit({ type: "duel_start", a: modelA, b: modelB });

  const messages: ChatMessageData[] = [
    { role: "system", content: systemPrompt },
    ...expandHistory(params.history).slice(-20),
    { role: "user", content: finalUserContent },
  ];

  // ── 3. The race: two independent lanes over the shared context ──
  const runLane = async (
    lane: "a" | "b",
    model: string
  ): Promise<DuelLaneResult> => {
    // Per-lane exact-match cache (the cache key includes the model).
    const cacheKey = computeCacheKey(
      finalUserContent,
      model,
      `${baseSystemPrompt}\n\n${liveContextBlockHourStable()}`
    );
    const cached = await getCached(cacheKey);
    if (cached) {
      // Contract enforcement applies to cached search answers too.
      if (sources.length && !confidenceOf(cached.content)) {
        cached.content = await appendConfidenceLabel(cached.content);
      }
      // Cached lane answers type out live too (word by word),
      // exactly like a fresh lane.
      await revealWords(cached.content, (text) =>
        emit({ type: "delta", lane, text })
      );
      await db.usageEvent.create({
        data: {
          keyId: null,
          providerId: provider.id,
          chatId,
          model,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          multiplier: provider.tokenMultiplier,
          cached: true,
        },
      });
      const result: DuelLaneResult = {
        lane,
        model,
        content: cached.content,
        tokens: 0,
        rawTokens: 0,
        cached: true,
        servedBy: "cache",
        keyLabel: "cache",
        error: null,
      };
      emit({ type: "lane_done", ...result });
      return result;
    }

    try {
      const routed = await dispatchCompletion({
        provider,
        model,
        messages,
        onDelta: (text) => emit({ type: "delta", lane, text }),
        // Mid-stream death in THIS lane → the cloud re-emits this
        // lane from scratch; clear only this lane's partial text.
        onRestart: () => emit({ type: "restart", lane }),
        // Deep effort → both lanes' cloud failover thinks too.
        thinking: effort === "deep",
      });
      const exec = routed.exec;
      const key = routed.key;

      if (sources.length && !confidenceOf(exec.content)) {
        exec.content = await appendConfidenceLabel(exec.content);
      }

      // Per-lane billing — identical rules to a normal turn: only
      // the key that actually served is charged; cloud lanes bill
      // no key.
      const rawTotal =
        exec.totalTokens ||
        exec.promptTokens + exec.completionTokens ||
        estimateTokens(finalUserContent) + estimateTokens(exec.content);
      await db.usageEvent.create({
        data: {
          keyId: key?.id ?? null,
          providerId: provider.id,
          chatId,
          model,
          promptTokens: exec.promptTokens,
          completionTokens: exec.completionTokens,
          totalTokens: rawTotal,
          multiplier: provider.tokenMultiplier,
          cached: false,
        },
      });
      if (key) {
        const now = new Date();
        const mk = monthKey(now);
        const monthAgg = await db.usageEvent.aggregate({
          _sum: { totalTokens: true },
          where: {
            keyId: key.id,
            createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), 1) },
          },
        });
        await db.apiKey.update({
          where: { id: key.id },
          data: {
            lastUsedAt: now,
            monthKey: mk,
            tokensUsedThisMonth: monthAgg._sum.totalTokens ?? rawTotal,
          },
        });
      }

      await putCached({
        cacheKey,
        model,
        provider: provider.name,
        content: exec.content,
        tokens: rawTotal,
      });

      const result: DuelLaneResult = {
        lane,
        model,
        content: exec.content,
        tokens: Math.round(rawTotal * provider.tokenMultiplier),
        rawTokens: rawTotal,
        cached: false,
        servedBy: exec.servedBy,
        keyLabel: key?.label ?? null,
        error: null,
      };
      emit({ type: "lane_done", ...result });
      return result;
    } catch (e) {
      // One lane failing must never kill the other — the duel
      // degrades to a single-lane answer the user can still keep.
      const result: DuelLaneResult = {
        lane,
        model,
        content: "",
        tokens: 0,
        rawTokens: 0,
        cached: false,
        servedBy: null,
        keyLabel: null,
        error: (e as Error).message || "Generation failed",
      };
      emit({ type: "lane_done", ...result });
      return result;
    }
  };

  const [a, b] = await Promise.all([
    runLane("a", modelA),
    runLane("b", modelB),
  ]);

  if (a.error && b.error) {
    emit({
      type: "error",
      message: `Both models failed — A (${modelA}): ${a.error} · B (${modelB}): ${b.error}`,
    });
    return { chatId, userMessageId, title, sources, lanes: { a, b }, bothFailed: true };
  }

  // No assistant message is persisted here — the client picks the
  // winner and /api/chat/duel/pick stores it (with the runner-up).
  emit({
    type: "done",
    chatId,
    userMessageId,
    assistantMessageId: null,
    duel: { a, b },
    // Top-level fields mirror lane A for simple/legacy consumers.
    content: a.content,
    cached: a.cached,
    tokens: a.tokens,
    rawTokens: a.rawTokens,
    servedBy: a.servedBy,
    keyLabel: a.keyLabel,
    providerName: provider.name,
    model: modelA,
    sources,
    searchFailed: params.search && sources.length === 0,
  });
  return { chatId, userMessageId, title, sources, lanes: { a, b }, bothFailed: false };
}
