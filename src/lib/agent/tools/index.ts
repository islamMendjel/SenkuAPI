// Hermes — THE EXOCORE (Run 40): the agent tool registry.
// Every tool is a REAL capability the gateway already has — no
// stubs, no fake results:
//
//   web_search     the grounded DDG pipeline (3 snippets, ≤300 chars,
//                  HTML stripped — the same discipline the UI uses)
//   calculator     a strictly-validated math evaluator (no eval of
//                  arbitrary input — names whitelisted, charset locked)
//   system_status  live pool truth: active provider, per-key health,
//                  rotation cursor, usage aggregates, chat counts
//   jev_decide     the Jev AI ensemble (free/jev-1.13) for
//                  arbitration between conflicting paths
//
// The orchestrator injects these schemas into the system prompt and
// executes whatever the model requests — results flow back as
// TOOL_RESULT turns (ReAct).

import { webSearch } from "@/lib/hermes/search";
import { arbitrateDecision } from "@/lib/agent/decisions";
import { keyHealthSnapshot } from "@/lib/hermes/keyhealth";
import { getActiveProvider } from "@/lib/hermes/router";
import { db } from "@/lib/db";

export interface ToolOutcome {
  /** One line for the human-readable trace. */
  summary: string;
  /** Full text handed to the model as the TOOL_RESULT. */
  detail: string;
}

export interface AgentTool {
  name: string;
  description: string;
  /** JSON schema of the args object. */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<ToolOutcome>;
}

// ── web_search ───────────────────────────────────────────────

const webSearchTool: AgentTool = {
  name: "web_search",
  description:
    "Search the live web (DuckDuckGo). Returns up to 3 dated, HTML-stripped snippets (≤300 chars each) with title, host and URL. Use for anything fresh, factual or time-sensitive.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query (≤200 chars)" },
    },
    required: ["query"],
  },
  async execute(args) {
    const query =
      typeof args.query === "string" ? args.query.trim().slice(0, 200) : "";
    if (!query) {
      return { summary: "web_search — empty query rejected", detail: "ERROR: query must be a non-empty string." };
    }
    const sources = await webSearch(query);
    if (!sources.length) {
      return {
        summary: `web_search("${query.slice(0, 60)}") — no results`,
        detail: `No web results for "${query}". Tell the user the search came back empty — do not invent facts.`,
      };
    }
    const lines = sources.map(
      (s, i) =>
        `[${i + 1}] ${s.title}\n    ${new URL(s.url).host}${s.dateHint ? ` · dated: ${s.dateHint}` : ""}\n    URL: ${s.url}\n    ${s.snippet}`
    );
    return {
      summary: `web_search("${query.slice(0, 60)}") — ${sources.length} source${sources.length === 1 ? "" : "s"}`,
      detail: `WEB RESULTS for "${query}" (retrieved ${new Date().toISOString()}):\n\n${lines.join("\n\n")}`,
    };
  },
};

// ── calculator ───────────────────────────────────────────────

const MATH_FUNCS: Record<string, string> = {
  sqrt: "Math.sqrt",
  cbrt: "Math.cbrt",
  abs: "Math.abs",
  round: "Math.round",
  floor: "Math.floor",
  ceil: "Math.ceil",
  sin: "Math.sin",
  cos: "Math.cos",
  tan: "Math.tan",
  asin: "Math.asin",
  acos: "Math.acos",
  atan: "Math.atan",
  log: "Math.log10",
  ln: "Math.log",
  exp: "Math.exp",
  min: "Math.min",
  max: "Math.max",
  pow: "Math.pow",
  pi: "Math.PI",
  e: "Math.E",
};

/** Strict math evaluation: known names are whitelisted, the residue
 *  must be digits/operators only, the result must be finite. */
export function safeMathEvaluate(expression: string): number {
  const normalized = expression
    .replace(/[×✕]/g, "*")
    .replace(/[÷]/g, "/")
    .replace(/[−–]/g, "-")
    .replace(/\^/g, "**");

  // strip known names (longest first so "asin" beats "sin")
  let residue = normalized;
  const names = Object.keys(MATH_FUNCS).sort((a, b) => b.length - a.length);
  for (const name of names) {
    residue = residue.replace(new RegExp(`\\b${name}\\b`, "gi"), " ");
  }
  if (/[a-z_]/i.test(residue)) {
    throw new Error("expression contains forbidden letters");
  }
  if (!/^[\d\s+\-*/().%*]+$/.test(residue)) {
    throw new Error("expression contains invalid characters");
  }

  let evalStr = normalized;
  for (const [name, repl] of Object.entries(MATH_FUNCS).sort(
    (a, b) => b[0].length - a[0].length
  )) {
    evalStr = evalStr.replace(new RegExp(`\\b${name}\\b`, "gi"), repl);
  }

  const result: unknown = Function(`"use strict"; return (${evalStr});`)();
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error("expression did not evaluate to a finite number");
  }
  return result;
}

const calculatorTool: AgentTool = {
  name: "calculator",
  description:
    "Evaluate a mathematical expression exactly (arithmetic, parentheses, powers, sqrt/sin/cos/log/min/max/pi…). Use for ANY non-trivial arithmetic instead of doing it in your head.",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: 'e.g. "239481 * 34839" or "sqrt(2) * pi"' },
    },
    required: ["expression"],
  },
  async execute(args) {
    const expr = typeof args.expression === "string" ? args.expression.trim() : "";
    if (!expr || expr.length > 300) {
      return {
        summary: "calculator — invalid expression",
        detail: "ERROR: expression must be a non-empty string (≤300 chars).",
      };
    }
    try {
      const value = safeMathEvaluate(expr);
      const pretty = value.toLocaleString("en-US", { maximumFractionDigits: 10 });
      return {
        summary: `calculator(${expr.slice(0, 60)}) = ${pretty}`,
        detail: `${expr} = ${pretty}\n(raw: ${value})`,
      };
    } catch (e) {
      return {
        summary: `calculator(${expr.slice(0, 60)}) — rejected`,
        detail: `ERROR: could not evaluate "${expr}": ${(e as Error).message}. Rewrite the expression with digits, + - * / ( ) % and the whitelisted functions.`,
      };
    }
  },
};

// ── system_status ────────────────────────────────────────────

const systemStatusTool: AgentTool = {
  name: "system_status",
  description:
    "Report the gateway's live state: active provider, pooled key health (circuit breaker cooldowns), rotation cursor, token usage aggregates and chat counts. Use when the user asks about the gateway, keys, usage or pool.",
  parameters: { type: "object", properties: {} },
  async execute() {
    const provider = await getActiveProvider();
    const keys = await db.apiKey.findMany({
      where: { providerId: provider.id, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    const health = keyHealthSnapshot();
    const now = Date.now();
    const since24h = new Date(now - 24 * 3600_000);
    const [allTime, day, chatCount, msgCount] = await Promise.all([
      db.usageEvent.aggregate({ _sum: { totalTokens: true } }),
      db.usageEvent.aggregate({
        _sum: { totalTokens: true },
        where: { createdAt: { gte: since24h } },
      }),
      db.chat.count(),
      db.message.count(),
    ]);

    const keyLines = keys.map((k, i) => {
      const cooling = health[k.id];
      const state = cooling
        ? `COOLING until ${cooling.coolingUntil} (${cooling.strikes} strike${cooling.strikes === 1 ? "" : "s"})`
        : "healthy";
      return `  #${i + 1} ${k.label} — ${state} · ${k.tokensUsedThisMonth.toLocaleString("en-US")} tokens this month`;
    });

    const detail = [
      `ACTIVE PROVIDER: ${provider.name} (${provider.slug})`,
      `  base URL: ${provider.baseUrl ?? "none"}`,
      `  rotation cursor (next seat): ${provider.rotationCursor}`,
      `  multiplier: ×${provider.tokenMultiplier}`,
      "",
      `KEY POOL (${keys.length} active):`,
      ...keyLines,
      "",
      `USAGE: ${(day._sum.totalTokens ?? 0).toLocaleString("en-US")} tokens · last 24h`,
      `  ${(allTime._sum.totalTokens ?? 0).toLocaleString("en-US")} tokens · all time`,
      "",
      `WORKSPACE: ${chatCount.toLocaleString("en-US")} chats · ${msgCount.toLocaleString("en-US")} messages`,
    ].join("\n");

    const coolingCount = keys.filter((k) => health[k.id]).length;
    return {
      summary: `system_status — ${provider.name}, ${keys.length - coolingCount}/${keys.length} keys healthy`,
      detail,
    };
  },
};

// ── jev_decide ───────────────────────────────────────────────

const jevDecideTool: AgentTool = {
  name: "jev_decide",
  description:
    "Ask the Jev AI ensemble decision model (free/jev-1.13) to arbitrate between 2-8 mutually exclusive options given explicit criteria. Use when paths genuinely conflict and the choice is strategic, not obvious.",
  parameters: {
    type: "object",
    properties: {
      options: {
        type: "array",
        items: { type: "string" },
        description: "2-8 mutually exclusive paths to choose from",
      },
      criteria: { type: "string", description: "The decision rule" },
      context: { type: "string", description: "Background the arbiter should weigh" },
    },
    required: ["options", "criteria"],
  },
  async execute(args) {
    const options = Array.isArray(args.options)
      ? args.options.filter((o): o is string => typeof o === "string")
      : [];
    const criteria = typeof args.criteria === "string" ? args.criteria : "";
    const context = typeof args.context === "string" ? args.context : "";
    if (options.length < 2 || !criteria.trim()) {
      return {
        summary: "jev_decide — invalid input",
        detail: "ERROR: options needs ≥2 strings and criteria must be non-empty.",
      };
    }
    try {
      const result = await arbitrateDecision({ options, criteria, context });
      const ranking = result.ranking.length
        ? "\n" + result.ranking.map((r, i) => `  ${i + 1}. ${r.option}${r.score !== undefined ? ` (score ${r.score})` : ""}`).join("\n")
        : "";
      const basisNote =
        result.decisionBasis === "option-match"
          ? ""
          : "\nNOTE: the ensemble uses a fixed taxonomy and could NOT rank your options — the verdict above is its classification of the task, not a choice among your options. Decide yourself, informed by the assessment.";
      return {
        summary: `jev_decide → ${result.decisionBasis === "option-match" ? `"${result.decision.slice(0, 60)}"` : "assessment"}`,
        detail: `DECISION BASIS: ${result.decisionBasis}\nDECISION: ${result.decision || "(none)"}${ranking}\n${result.rationale ? `\nAssessment: ${result.rationale}` : ""}${basisNote}\n(arbitrated by ${result.servedBy.model} via ${result.servedBy.key ?? "cloud"})`,
      };
    } catch (e) {
      return {
        summary: "jev_decide — engine unreachable",
        detail: `ERROR: the decision engine could not be reached: ${(e as Error).message}. Decide yourself and say so explicitly.`,
      };
    }
  },
};

// ── Registry ─────────────────────────────────────────────────

export const AGENT_TOOLS: AgentTool[] = [
  webSearchTool,
  calculatorTool,
  systemStatusTool,
  jevDecideTool,
];

export function getTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; summary: string; detail: string }> {
  const tool = getTool(name);
  if (!tool) {
    return {
      ok: false,
      summary: `${name} — unknown tool`,
      detail: `ERROR: unknown tool "${name}". Available: ${AGENT_TOOLS.map((t) => t.name).join(", ")}.`,
    };
  }
  try {
    const outcome = await tool.execute(args);
    return { ok: true, ...outcome };
  } catch (e) {
    return {
      ok: false,
      summary: `${name} — crashed`,
      detail: `ERROR: tool "${name}" failed: ${(e as Error).message}`,
    };
  }
}

/** The tool schema block injected into the agent's system prompt. */
export function toolSchemasPrompt(): string {
  return JSON.stringify(
    AGENT_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    null,
    2
  );
}
