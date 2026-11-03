// Hermes — THE EXOCORE (Run 40): the agent turn as a FIRST-CLASS
// chat turn. runAgentTurn mirrors runChatTurn's full lifecycle —
// project resolution, memory injection, chat + user persistence with
// THE FORK tree rules (nextChildSlot / advanceLeaf), per-turn usage
// accounting with key attribution and monthly accumulator rolls,
// honest tokensEstimated markers — but the completion phase is the
// AGENT LOOP (tools, arbitration, up to N ReAct turns) instead of a
// single dispatch. Nothing about the tree, the limiter or the
// ledger can tell an agent turn from a normal one.

import { db } from "@/lib/db";
import { attachmentContextBlock, sanitizeAttachments } from "./attachments";
import {
  DEFAULT_MODEL,
  liveContextBlock,
  memoryBlock,
  projectBlock,
} from "./constants";
import { estimateTokens } from "./executor";
import { deriveTitle } from "./gateway";
import { getMemories } from "./memory";
import { projectForTurn } from "./projects";
import { getActiveProvider } from "./router";
import { advanceLeaf, currentLeaf, nextChildSlot } from "./tree";
import {
  runAgentTask,
  type AgentEvent,
} from "@/lib/agent/orchestrator";
import type { AttachmentRecord, ChatMessageData } from "./types";

export interface AgentTurnParams {
  chatId?: string | null;
  history: ChatMessageData[]; // prior turns (already persisted)
  content: string; // new user message
  model: string;
  temporary: boolean;
  persistUser?: boolean;
  projectId?: string | null;
  attachments?: unknown;
  /** Cap on the agent's model turns (1-8). */
  maxTurns?: number;
  signal?: AbortSignal;
  emit: (ev: Record<string, unknown>) => void;
}

export async function runAgentTurn(params: AgentTurnParams): Promise<void> {
  const { emit } = params;
  const provider = await getActiveProvider();
  const providerModels = JSON.parse(provider.models || "[]") as string[];
  const model =
    params.model && providerModels.includes(params.model)
      ? params.model
      : (providerModels[0] ?? DEFAULT_MODEL);
  // Untrusted client payload — rebuilt field-by-field server-side.
  const attachments: AttachmentRecord[] = sanitizeAttachments(params.attachments);

  // Context (project + memory) resolves BEFORE persistence — a new
  // chat is stamped with the draft project the moment it's born.
  const memories = await getMemories();
  const project = await projectForTurn(params.chatId, params.projectId);

  // ── 1. Persistence: chat row + user message (fork-safe) ──
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
          projectId: project?.id ?? null,
        },
      });
      chatId = chat.id;
    }
    const slot = await nextChildSlot(chatId, (await currentLeaf(chatId)).id);
    const userMsg = await db.message.create({
      data: {
        chatId,
        role: "user",
        content: params.content,
        attachments: attachments.length ? JSON.stringify(attachments) : null,
        parentMessageId: slot.parentMessageId,
        branchIndex: slot.branchIndex,
      },
    });
    userMessageId = userMsg.id;
    await advanceLeaf(chatId, userMsg.id);
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
    agent: true,
  });

  // ── 2. The agent loop ──
  // Memory + project + live clock ride along (they are CONTEXT, not
  // protocol — the strict JSON tool contract stays intact).
  const contextBlock = [
    memoryBlock(memories),
    project ? projectBlock(project.name, project.instructions) : "",
    liveContextBlock(),
  ]
    .filter(Boolean)
    .join("\n\n");

  const finalUserContent =
    params.content +
    (attachments.length ? attachmentContextBlock(attachments) : "");

  const trace: string[] = [];
  try {
    const result = await runAgentTask({
      prompt: contextBlock ? `${finalUserContent}\n\n---\n${contextBlock}` : finalUserContent,
      model,
      maxTurns: params.maxTurns,
      signal: params.signal,
      onEvent: (ev: AgentEvent) => {
        if (ev.type === "turn") {
          emit({ type: "agent_status", message: `Turn ${ev.turn} of ${ev.maxTurns}` });
        } else if (ev.type === "tool_call") {
          emit({ type: "agent_tool", tool: ev.tool, ok: null });
        } else if (ev.type === "tool_result") {
          trace.push(`${ev.ok ? "✓" : "✗"} ${ev.summary}`);
          emit({ type: "agent_tool", tool: ev.tool, ok: ev.ok, summary: ev.summary });
          emit({ type: "agent_trace", trace: [...trace] });
        }
      },
    });

    // ── 3. Usage accounting — one honest UsageEvent per model call,
    // key-attributed so the pacing limiter sees every token. ──
    let rawTotal = 0;
    let usageReportedAny = false;
    let lastKeyLabel: string | null = null;
    for (const row of result.accounting) {
      rawTotal += row.totalTokens;
      usageReportedAny = usageReportedAny || row.usageReported;
      if (row.keyLabel) lastKeyLabel = row.keyLabel;
      await db.usageEvent.create({
        data: {
          keyId: row.keyId,
          providerId: provider.id,
          chatId,
          model: row.model,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          totalTokens: row.totalTokens,
          multiplier: provider.tokenMultiplier,
          cached: false,
        },
      });
      if (row.keyId) {
        await db.apiKey
          .update({ where: { id: row.keyId }, data: { lastUsedAt: new Date() } })
          .catch(() => undefined);
      }
    }
    // Monthly accumulator rolls (limiter truth) — sum per key.
    const keyIds = [...new Set(result.accounting.map((r) => r.keyId).filter((k): k is string => k !== null))];
    if (keyIds.length) {
      const now = new Date();
      const mk = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const monthAgg = await db.usageEvent.aggregate({
        _sum: { totalTokens: true },
        where: {
          keyId: { in: keyIds },
          createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), 1) },
        },
      });
      await db.apiKey
        .updateMany({
          where: { id: { in: keyIds } },
          data: { monthKey: mk, tokensUsedThisMonth: monthAgg._sum.totalTokens ?? 0 },
        })
        .catch(() => undefined);
    }

    // Honesty marker: without upstream usage stats the counts are
    // chars/4 estimates (same rule as the gateway).
    const tokensEstimated = !usageReportedAny && rawTotal > 0;
    const effectiveTokens = Math.round(
      (rawTotal || estimateTokens(finalUserContent) + estimateTokens(result.answer)) *
        provider.tokenMultiplier
    );

    // ── 4. Persist the assistant row: trace + final answer — exactly
    // what the timeline showed, reload-stable. ──
    const persistedContent = [
      trace.length ? trace.join("  \n") : "",
      result.answer,
    ]
      .filter(Boolean)
      .join("\n\n---\n\n");

    let assistantMessageId: string | null = null;
    if (!params.temporary && chatId && persistedContent.trim()) {
      const slot = await nextChildSlot(
        chatId,
        userMessageId ?? (await currentLeaf(chatId)).id
      );
      const msg = await db.message.create({
        data: {
          chatId,
          role: "assistant",
          content: persistedContent,
          model,
          provider: provider.name,
          keyLabel: lastKeyLabel,
          tokens: effectiveTokens,
          tokensEstimated,
          cached: false,
          parentMessageId: slot.parentMessageId,
          branchIndex: slot.branchIndex,
        },
      });
      assistantMessageId = msg.id;
      await advanceLeaf(chatId, msg.id);
      await db.chat.update({
        where: { id: chatId },
        data: { updatedAt: new Date(), model, provider: provider.name },
      });
    }

    emit({
      type: "done",
      chatId,
      userMessageId,
      assistantMessageId,
      title,
      content: persistedContent,
      tokens: effectiveTokens,
      rawTokens: rawTotal,
      tokensEstimated,
      cached: false,
      servedBy: result.accounting.some((r) => r.servedBy === "zai-cloud")
        ? "zai-cloud"
        : "provider",
      keyLabel: lastKeyLabel,
      providerName: provider.name,
      model,
      agentTrace: trace,
      toolCalls: result.toolCalls.length,
    });
  } catch (e) {
    const err = e as Error;
    emit({
      type: "error",
      message: err.name === "AbortError" ? "Agent run stopped." : err.message || "The agent run failed.",
      code: "agent-error",
    });
  }
}
