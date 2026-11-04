// Senku Exocore Agent Service (Microservice Domain Entrypoint)
// ReAct tool execution engine, DuckDuckGo grounding, and Jev ensemble conflict resolution.

import { runAgentTask, type AgentEvent, type AgentRunResult } from "@/lib/agent/orchestrator";
import { arbitrateDecision, type ArbitrateInput, type ArbitrateResult } from "@/lib/agent/decisions";
import { executeTool, AGENT_TOOLS, toolSchemasPrompt } from "@/lib/agent/tools";
import type { IAgentService, AgentRunOptions } from "./types";

export * from "./types";
export {
  runAgentTask,
  arbitrateDecision,
  executeTool,
  AGENT_TOOLS,
  toolSchemasPrompt,
  type AgentEvent,
  type ArbitrateInput,
  type ArbitrateResult,
  type AgentRunResult,
};

class ExocoreAgentServiceImpl implements IAgentService {
  async runReActLoop(opts: AgentRunOptions): Promise<AgentRunResult> {
    return runAgentTask({
      prompt: opts.query,
      model: opts.model,
      maxTurns: opts.maxTurns,
      signal: opts.signal,
      onEvent: opts.onEvent,
    });
  }

  async arbitrateDecision(input: ArbitrateInput): Promise<ArbitrateResult> {
    return arbitrateDecision(input);
  }

  async executeToolCall(
    tool: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; summary: string }> {
    return executeTool(tool, args);
  }
}

export const exocoreAgent = new ExocoreAgentServiceImpl();
