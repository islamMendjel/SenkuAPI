// Senku Jarvis Core — Spoken Command Dispatcher & Autonomous Voice State Machine.
// Operates in pure English, translating natural spoken instructions into
// ReAct tool execution, Jev ensemble arbitration, or immediate spoken synthesis.

import { exocoreAgent } from "@/services/agent";
import { coreGateway } from "@/services/gateway";
import { arbitrateDecision } from "@/lib/agent/decisions";

export type JarvisState = "idle" | "listening" | "thinking" | "speaking" | "error";

export interface JarvisActionLog {
  timestamp: number;
  type: "speech_heard" | "tool_exec" | "decision_arb" | "spoken_reply";
  detail: string;
}

export interface JarvisDispatchResult {
  spokenText: string;
  markdownText: string;
  toolUsed?: string;
  actionSummary?: string;
  durationMs: number;
}

/** Sanitize Markdown into natural, clean speakable English. */
export function formatForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "Code block omitted.")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~#]/g, "")
    .replace(/>+/g, "")
    .replace(/[-*+]\s+/g, "")
    .replace(/\[(confirmed|partial|stale sources)\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Classify whether a spoken query requires Jev decision arbitration. */
function isDecisionQuery(query: string): boolean {
  const q = query.toLowerCase();
  return (
    (q.includes("decide between") ||
      q.includes("choose between") ||
      q.includes("which is better") ||
      q.includes("should i choose")) &&
    (q.includes(" or ") || q.includes(" versus ") || q.includes(" vs "))
  );
}

/** Extract decision options from a query like "decide between Next.js or Remix for my app". */
function extractDecisionOptions(query: string): { options: string[]; criteria: string } {
  const parts = query.replace(/^.*(?:between|choose)\s+/i, "").split(/\s+(?:or|versus|vs)\s+/i);
  if (parts.length >= 2) {
    const optA = parts[0].trim();
    const optB = parts[1].split(/\s+(?:for|based on|considering)\s+/i)[0].trim();
    return {
      options: [optA, optB],
      criteria: "Technical scalability, developer experience, and maintainability.",
    };
  }
  return {
    options: ["Option A", "Option B"],
    criteria: "Optimal balance of performance and efficiency.",
  };
}

/** Classify whether a spoken query demands active ReAct tool execution. */
function isOperationalCommand(query: string): boolean {
  const q = query.toLowerCase();
  return (
    q.startsWith("check") ||
    q.startsWith("status") ||
    q.startsWith("system") ||
    q.startsWith("search") ||
    q.startsWith("find") ||
    q.startsWith("calculate") ||
    q.startsWith("compute") ||
    q.includes("how much is") ||
    q.includes("what is the status") ||
    q.includes("search for") ||
    q.includes("latest news")
  );
}

export class JarvisDispatcher {
  /**
   * Main Dispatch Entrypoint:
   * Analyzes spoken input, chooses ReAct Agent, Jev Arbitrator, or Direct Gateway,
   * and yields clean speakable synthesis.
   */
  static async handleSpokenDirective(
    query: string,
    onStatus?: (status: string) => void,
    signal?: AbortSignal
  ): Promise<JarvisDispatchResult> {
    const t0 = Date.now();
    const clean = query.trim();

    if (!clean) {
      return {
        spokenText: "I did not catch that. How can I assist you?",
        markdownText: "No speech recognized.",
        durationMs: 0,
      };
    }

    // 1. Conflict / Decision query -> Jev AI ensemble arbitrator
    if (isDecisionQuery(clean)) {
      onStatus?.("Consulting Jev ensemble arbitrator…");
      const { options, criteria } = extractDecisionOptions(clean);
      try {
        const arb = await arbitrateDecision({
          options,
          criteria,
          context: clean,
        });

        const winner = arb.decision || options[0];
        const spoken = `I consulted the Jev ensemble. The recommendation is ${winner}. ${arb.rationale || ""}`;
        return {
          spokenText: formatForSpeech(spoken),
          markdownText: `### Jev Decision Arbitration\n\n**Recommendation:** ${winner}\n\n${arb.rationale}`,
          toolUsed: "jev_decide",
          actionSummary: `Arbitrated between ${options.join(" and ")}`,
          durationMs: Date.now() - t0,
        };
      } catch (err) {
        console.warn("[Jarvis] Jev arbitration fallback to agent loop:", err);
      }
    }

    // 2. Operational query -> Exocore ReAct tool loop
    if (isOperationalCommand(clean)) {
      onStatus?.("Executing operational tools…");
      try {
        let lastTool = "";
        const agentOutcome = await exocoreAgent.runReActLoop({
          query: clean,
          maxTurns: 4,
          signal,
          onEvent: (ev) => {
            if (ev.type === "tool_call") {
              lastTool = ev.tool;
              onStatus?.(`Running ${ev.tool}…`);
            }
          },
        });

        const speakable = formatForSpeech(agentOutcome.answer);
        const tools = agentOutcome.toolCalls.map((t) => t.tool);
        return {
          spokenText: speakable || "Action completed successfully.",
          markdownText: agentOutcome.answer,
          toolUsed: lastTool || tools[0],
          actionSummary: `Ran ${tools.join(", ") || "tools"} in ${agentOutcome.turns} turns`,
          durationMs: Date.now() - t0,
        };
      } catch (err) {
        console.warn("[Jarvis] Agent loop fallback to direct gateway:", err);
      }
    }

    // 3. Conversational / Direct assistance -> Core Gateway
    onStatus?.("Formulating response…");
    const turn = await coreGateway.dispatchTurn({
      model: "free/glm-5.3",
      messages: [{ role: "user", content: clean }],
      systemPrompt:
        "You are Senku's hands-free Jarvis voice assistant. Answer concisely and naturally in English. Keep answers under 3 sentences so they sound conversational when spoken aloud.",
      signal,
    });

    return {
      spokenText: formatForSpeech(turn.content),
      markdownText: turn.content,
      durationMs: Date.now() - t0,
    };
  }
}
