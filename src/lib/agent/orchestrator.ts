// Hermes — THE EXOCORE (Run 40): the agent orchestrator.
// A ReAct tool-calling loop over the SAME pooled infrastructure the
// chat UI uses: every turn is dispatched through dispatchCompletion
// (Orrery rotation, circuit breaker, pacing limiter, Z.ai cloud
// failover). The model either answers or requests ONE tool as a
// strict JSON object; the orchestrator executes it against the real
// registry, appends the TOOL_RESULT and continues — at most
// maxTurns model calls, then a forced synthesis. Nothing is faked:
// a tool that fails hands the error text back to the model, which
// must cope or admit the limit.

import { dispatchCompletion } from "@/lib/hermes/dispatch";
import { DEFAULT_MODEL } from "@/lib/hermes/constants";
import { getActiveProvider } from "@/lib/hermes/router";
import { executeTool, toolSchemasPrompt } from "./tools";
import type { ChatMessageData } from "@/lib/hermes/types";

export type AgentEvent =
  | { type: "status"; message: string }
  | { type: "turn"; turn: number; maxTurns: number }
  | { type: "tool_call"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; ok: boolean; summary: string }
  | { type: "final"; content: string }
  | { type: "error"; message: string };

export const AGENT_MAX_TURNS_DEFAULT = 5;
export const AGENT_MAX_TURNS_CAP = 8;

/** The agent's contract. Strict JSON tool calls keep the parser
 *  honest; the strictness is also the model's escape hatch — a
 *  reply that is not a tool call IS the final answer. */
function agentSystemPrompt(): string {
  return [
    "You are Senku Agent — the autonomous core of the Senku personal AI gateway.",
    "You can act. You have exactly these tools:",
    toolSchemasPrompt(),
    "",
    "TOOL CALL PROTOCOL — when you decide a tool would materially improve the answer,",
    'reply with ONLY one JSON object and nothing else: {"tool": "<name>", "args": {…}}.',
    "No prose, no fences, no explanation outside the JSON.",
    "",
    "FINAL ANSWER PROTOCOL — when you know enough (or no tool helps), reply with the",
    "answer itself in clean Markdown. That reply is final; never wrap it in JSON.",
    "",
    "RULES:",
    "• Never invent a tool result. Never claim you ran a tool you didn't request.",
    "• Arithmetic goes through calculator — never do multi-digit math in your head.",
    "• Anything fresh, factual or time-sensitive goes through web_search.",
    "• When two valid paths genuinely conflict, jev_decide arbitrates — then commit.",
    "• After each TOOL_RESULT, either act again or answer. One tool call per reply.",
    "• If a tool errors, adapt or tell the user the limit honestly.",
  ].join("\n");
}

/** Pull ONE strict tool call out of a model reply. A reply without
 *  a parseable {"tool": …} object is, by contract, the final answer.
 *  Models are sloppy: they double-emit, fence their JSON, pad with
 *  prose — every tolerated shape is tried before giving up. */
export function extractToolCall(
  content: string
): { tool: string; args: Record<string, unknown> } | null {
  const text = content.trim();
  if (!text.includes("{")) return null; // fast path: prose answer
  // code fences are decoration, never payload
  const unfenced = text.replace(/```(?:json)?/gi, "").trim();

  const candidates: string[] = [unfenced];
  // one object per line (the observed double-emit shape)
  for (const line of unfenced.split("\n")) {
    const t = line.trim();
    if (t.startsWith("{")) candidates.push(t);
  }
  // the first balanced {…} block (prose-padded JSON)
  const firstBrace = unfenced.indexOf("{");
  if (firstBrace >= 0) {
    const balanced = firstBalancedObject(unfenced, firstBrace);
    if (balanced) candidates.push(balanced);
  }

  for (const cand of candidates) {
    try {
      const parsed = JSON.parse(cand) as {
        tool?: unknown;
        args?: unknown;
      } | null;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      if (typeof parsed.tool !== "string" || !parsed.tool.trim()) continue;
      const args =
        parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)
          ? (parsed.args as Record<string, unknown>)
          : {};
      return { tool: parsed.tool.trim(), args };
    } catch {
      continue;
    }
  }
  return null;
}

/** The first balanced {…} block starting at `start` — brace depth
 *  tracked with string awareness so "}"inside values never lies. */
function firstBalancedObject(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export interface AgentTurnAccounting {
  keyId: string | null;
  keyLabel: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageReported: boolean;
  servedBy: "provider" | "zai-cloud";
}

export interface AgentRunResult {
  answer: string;
  turns: number;
  toolCalls: { tool: string; summary: string }[];
  /** Per-turn billing rows — one UsageEvent each, key-attributed,
   *  so the pacing limiter sees every token the agent spent. */
  accounting: AgentTurnAccounting[];
}

export async function runAgentTask(params: {
  prompt: string;
  model?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  onEvent?: (ev: AgentEvent) => void;
}): Promise<AgentRunResult> {
  const { prompt, signal, onEvent } = params;
  const maxTurns = Math.min(
    Math.max(1, params.maxTurns ?? AGENT_MAX_TURNS_DEFAULT),
    AGENT_MAX_TURNS_CAP
  );

  const provider = await getActiveProvider();
  const models: string[] = JSON.parse(provider.models || "[]");
  const model =
    params.model && models.includes(params.model)
      ? params.model
      : (models[0] ?? DEFAULT_MODEL);

  const emit = (ev: AgentEvent) => {
    try {
      onEvent?.(ev);
    } catch {
      // a dead listener never breaks the loop
    }
  };

  const messages: ChatMessageData[] = [
    { role: "system", content: agentSystemPrompt() },
    { role: "user", content: prompt },
  ];

  const toolCalls: { tool: string; summary: string }[] = [];
  const accounting: AgentTurnAccounting[] = [];
  let lastContent = "";

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    emit({ type: "turn", turn, maxTurns });

    const routed = await dispatchCompletion({
      provider,
      model,
      messages,
      signal,
    });
    const exec = routed.exec;
    accounting.push({
      keyId: routed.key?.id ?? null,
      keyLabel: routed.key?.label ?? null,
      model,
      promptTokens: exec.promptTokens,
      completionTokens: exec.completionTokens,
      totalTokens: exec.totalTokens || exec.promptTokens + exec.completionTokens,
      usageReported: exec.usageReported ?? false,
      servedBy: exec.servedBy,
    });
    const content = routed.exec.content.trim();
    lastContent = content;

    const call = extractToolCall(content);
    if (!call) {
      emit({ type: "final", content });
      return { answer: content, turns: turn, toolCalls, accounting };
    }

    emit({ type: "tool_call", tool: call.tool, args: call.args });
    const outcome = await executeTool(call.tool, call.args);
    toolCalls.push({ tool: call.tool, summary: outcome.summary });
    emit({
      type: "tool_result",
      tool: call.tool,
      ok: outcome.ok,
      summary: outcome.summary,
    });

    messages.push({ role: "assistant", content });
    messages.push({
      role: "user",
      content: `TOOL_RESULT — ${call.tool}:\n${outcome.detail}\n\nContinue: reply with the next tool call (strict JSON) or your final answer (Markdown).`,
    });
  }

  // Tool budget exhausted — one forced synthesis, no more tools.
  emit({ type: "status", message: "Tool budget reached — synthesizing the answer." });
  messages.push({
    role: "user",
    content:
      "You have used your tool budget. Reply with your FINAL ANSWER now — plain Markdown, no tool calls.",
  });
  const routed = await dispatchCompletion({
    provider,
    model,
    messages,
    signal,
  });
  const exec = routed.exec;
  accounting.push({
    keyId: routed.key?.id ?? null,
    keyLabel: routed.key?.label ?? null,
    model,
    promptTokens: exec.promptTokens,
    completionTokens: exec.completionTokens,
    totalTokens: exec.totalTokens || exec.promptTokens + exec.completionTokens,
    usageReported: exec.usageReported ?? false,
    servedBy: exec.servedBy,
  });
  lastContent = exec.content.trim();
  emit({ type: "final", content: lastContent });
  return { answer: lastContent, turns: maxTurns + 1, toolCalls, accounting };
}
