// Senku Exocore Agent — Domain Contracts and Types.
// Autonomous ReAct tool execution loop, DuckDuckGo grounding,
// safe arithmetic parser, and Jev AI ensemble arbitrator.

import type { AgentEvent, AgentRunResult } from "@/lib/agent/orchestrator";
import type { ArbitrateInput, ArbitrateResult } from "@/lib/agent/decisions";

export interface AgentRunOptions {
  query: string;
  model?: string;
  maxTurns?: number;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface IAgentService {
  runReActLoop(opts: AgentRunOptions): Promise<AgentRunResult>;
  arbitrateDecision(input: ArbitrateInput): Promise<ArbitrateResult>;
  executeToolCall(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; summary: string }>;
}
