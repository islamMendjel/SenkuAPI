// Hermes — THE EXOCORE (Run 40): the Jev AI Decision Adapter.
// `free/jev-1.13` is an ENSEMBLE DECISION model — probed 2026-11-03:
// apinex answers 400 "Jev Group Decision model and cannot be called
// on /v1/chat/completions" (it lives in APINEX_NON_CHAT_IDS). Its
// home is POST /v1/decisions, where it takes OPTIONS + CRITERIA +
// CONTEXT and returns a structured arbitration.
//
// Hermes uses Jev wherever the agent must choose between conflicting
// paths or tools — and exposes it to the UI and the agent loop via
// /api/decisions.
//
// Failure discipline mirrors the rest of the gateway: keys are drawn
// through the Orrery pickKey ring, a pre-answer failure (401/403/
// 429/5xx) breaker-marks the key and retries the next one (≤3
// retries), and the answer is NEVER fabricated — an upstream that
// cannot answer throws a coded error.

import { classifyStatus, type BridgeKey } from "@/lib/hermes/bridge";
import { noteKeyFailure, noteKeySuccess } from "@/lib/hermes/keyhealth";
import { pickKey } from "@/lib/hermes/router";
import { ensureSeed } from "@/lib/hermes/seed";
import { db } from "@/lib/db";

export const JEV_MODEL = "free/jev-1.13";
export const JEV_MAX_OPTIONS = 8;
export const JEV_MAX_OPTION_CHARS = 300;
export const JEV_MAX_CRITERIA_CHARS = 1000;
export const JEV_MAX_CONTEXT_CHARS = 4000;

export interface ArbitrateInput {
  options: string[];
  criteria: string;
  context?: string;
}

export interface DecisionRanking {
  option: string;
  score?: number;
}

export interface JevAssessment {
  /** ensemble uncertainty ("noul"), 0-1 */
  uncertainty?: number;
  /** safety score ("is_safe" noul), 0-1 */
  isSafe?: number;
  category?: {
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
  };
  complexity?: {
    score: number;
    label: string;
    probabilities: Record<string, number>;
    confidence: number;
  };
}

export interface ArbitrateResult {
  /** The chosen option — WHEN the ensemble's verdict maps onto one.
   *  Jev is a fixed-taxonomy assessor (coding/general/analysis/
   *  creative), so often it CANNOT rank caller options; honesty
   *  beats fantasy: decisionBasis says which world you're in. */
  decision: string;
  decisionBasis: "option-match" | "ensemble-classification";
  ranking: DecisionRanking[];
  /** The full ensemble verdict, verbatim fields. */
  assessment: JevAssessment;
  rationale: string;
  servedBy: { key: string | null; model: string; attempts: number };
}

/** A typed upstream failure — the route turns it into an honest
 *  HTTP error instead of a guessed decision. */
export class JevError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 502, code = "jev-upstream") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function clampOption(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  return t.slice(0, JEV_MAX_OPTION_CHARS);
}

/** Validate + normalize the input; throws JevError(400) on garbage. */
export function normalizeArbitrateInput(input: ArbitrateInput): Required<ArbitrateInput> {
  const options = (Array.isArray(input.options) ? input.options : [])
    .map(clampOption)
    .filter((o): o is string => o !== null)
    .slice(0, JEV_MAX_OPTIONS);
  if (options.length < 2) {
    throw new JevError(
      `options: at least 2 (max ${JEV_MAX_OPTIONS}) non-empty choices are required`,
      400,
      "invalid_options"
    );
  }
  const criteria =
    typeof input.criteria === "string" && input.criteria.trim()
      ? input.criteria.trim().slice(0, JEV_MAX_CRITERIA_CHARS)
      : "";
  if (!criteria) {
    throw new JevError("criteria: a decision rule is required", 400, "invalid_criteria");
  }
  const context =
    typeof input.context === "string" && input.context.trim()
      ? input.context.trim().slice(0, JEV_MAX_CONTEXT_CHARS)
      : "";
  return { options, criteria, context };
}

// ── Response normalization ───────────────────────────────────
// The REAL upstream envelope (probed 2026-11-03, twice, different
// payloads — identical shape):
//   { object: "decision", model, answers: {
//       assessment: {type:"noul", noul:0.49},
//       is_safe:    {type:"noul", noul:0.92},
//       category:   {type:"choice", choice:"analysis",
//                    probabilities:{coding,general,analysis,creative}, confidence},
//       complexity: {type:"score", score:0.17,
//                    legend:{...bucket labels}, probabilities, confidence} },
//     usage: {...} }
// It is a fixed-taxonomy ensemble ASSESSMENT — it does NOT rank
// caller options. The adapter extracts the assessment honestly and
// derives a decision only when a choice value actually matches one.

interface RawAnswerValue {
  type?: unknown;
  noul?: unknown;
  choice?: unknown;
  score?: unknown;
  legend?: unknown;
  probabilities?: unknown;
  confidence?: unknown;
}

interface RawDecision {
  decision?: unknown;
  chosen?: unknown;
  selected?: unknown;
  winner?: unknown;
  best_option?: unknown;
  rationale?: unknown;
  reasoning?: unknown;
  explanation?: unknown;
  ranking?: unknown;
  scores?: unknown;
  options?: unknown;
  answers?: Record<string, RawAnswerValue>;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asOptionText(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (v && typeof v === "object") {
    const o = v as { option?: unknown; text?: unknown; name?: unknown; value?: unknown };
    for (const k of ["option", "text", "name", "value"] as const) {
      if (typeof o[k] === "string" && (o[k] as string).trim()) {
        return (o[k] as string).trim();
      }
    }
  }
  return null;
}

function asProbabilities(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const n = num(val);
      if (n !== undefined) out[k] = n;
    }
  }
  return out;
}

function legendLabel(score: number, legend: unknown): string {
  if (legend && typeof legend === "object" && !Array.isArray(legend)) {
    // legend keys are score buckets ("0".."4") — the floor bucket labels
    const floor = String(Math.floor(score));
    const label = (legend as Record<string, unknown>)[floor];
    if (typeof label === "string" && label) return label;
  }
  return "";
}

function extractAssessment(
  answers: Record<string, RawAnswerValue> | undefined
): JevAssessment {
  const a: JevAssessment = {};
  if (!answers) return a;
  const assessment = answers.assessment;
  if (assessment && typeof assessment === "object") a.uncertainty = num(assessment.noul);
  const safe = answers.is_safe ?? answers.isSafe;
  if (safe && typeof safe === "object") a.isSafe = num(safe.noul);
  const cat = answers.category;
  if (cat && typeof cat === "object" && typeof cat.choice === "string") {
    a.category = {
      choice: cat.choice,
      probabilities: asProbabilities(cat.probabilities),
      confidence: num(cat.confidence) ?? 0,
    };
  }
  const cx = answers.complexity;
  if (cx && typeof cx === "object" && num(cx.score) !== undefined) {
    const score = num(cx.score)!;
    a.complexity = {
      score,
      label: legendLabel(score, cx.legend),
      probabilities: asProbabilities(cx.probabilities),
      confidence: num(cx.confidence) ?? 0,
    };
  }
  return a;
}

function assessmentRationale(a: JevAssessment): string {
  const parts: string[] = [];
  if (a.category) {
    parts.push(
      `classifies this task as "${a.category.choice}" (${Math.round(a.category.confidence * 100)}% confidence)`
    );
  }
  if (a.complexity) {
    parts.push(
      `complexity ${a.complexity.score.toFixed(2)}/4${a.complexity.label ? ` (${a.complexity.label})` : ""}`
    );
  }
  if (a.isSafe !== undefined) parts.push(`safety ${a.isSafe.toFixed(2)}`);
  if (a.uncertainty !== undefined) parts.push(`ensemble uncertainty ${a.uncertainty.toFixed(2)}`);
  return parts.join(" · ");
}

/** The decision: an option-match when the ensemble's own choice
 *  names one of the caller's options; otherwise the ensemble's
 *  taxonomy classification, labeled as such. Never invented. */
function deriveDecision(
  assessment: JevAssessment,
  options: string[]
): { decision: string; basis: "option-match" | "ensemble-classification"; ranking: DecisionRanking[] } {
  if (assessment.category) {
    const choice = assessment.category.choice;
    const match = options.find((o) => o.toLowerCase() === choice.toLowerCase());
    if (match) {
      return {
        decision: match,
        basis: "option-match",
        ranking: [{ option: match, score: assessment.category.confidence }],
      };
    }
    // The taxonomy probabilities are the ensemble's honest ranking —
    // of ITS categories, not of the caller's options.
    const taxonomy = Object.entries(assessment.category.probabilities)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => ({ option: k, score: v }));
    return { decision: choice, basis: "ensemble-classification", ranking: taxonomy };
  }
  return { decision: "", basis: "ensemble-classification", ranking: [] };
}

/** Extract the verdict from any plausible envelope — the real
 *  ensemble shape first, simple/legacy shapes as a fallback. */
export function normalizeDecisionResponse(
  raw: unknown,
  options: string[]
): {
  decision: string;
  decisionBasis: "option-match" | "ensemble-classification";
  ranking: DecisionRanking[];
  assessment: JevAssessment;
  rationale: string;
} | null {
  const candidates: unknown[] = [raw];
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (o.data && typeof o.data === "object") candidates.push(o.data);
    if (o.result && typeof o.result === "object") candidates.push(o.result);
    const content = (o.choices as
      | { message?: { content?: unknown } }[]
      | undefined)?.[0]?.message?.content;
    if (typeof content === "string" && content.trim()) {
      try {
        candidates.push(JSON.parse(content));
      } catch {
        candidates.push({ decision: content.trim() });
      }
    }
  }

  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const o = c as RawDecision;

    // 1. The real ensemble shape.
    if (o.answers && typeof o.answers === "object") {
      const assessment = extractAssessment(o.answers);
      if (assessment.category || assessment.uncertainty !== undefined) {
        const derived = deriveDecision(assessment, options);
        return {
          decision: derived.decision,
          decisionBasis: derived.basis,
          ranking: derived.ranking,
          assessment,
          rationale: assessmentRationale(assessment),
        };
      }
    }

    // 2. Legacy/simple shapes ({decision: …}) — in case the upstream
    //    grows a ranking mode later.
    const decision =
      asOptionText(o.decision) ??
      asOptionText(o.chosen) ??
      asOptionText(o.selected) ??
      asOptionText(o.winner) ??
      asOptionText(o.best_option);
    if (decision) {
      const match = options.find((op) => op.toLowerCase() === decision.toLowerCase());
      return {
        decision: match ?? decision,
        decisionBasis: match ? "option-match" : "ensemble-classification",
        ranking: [],
        assessment: {},
        rationale:
          typeof o.rationale === "string"
            ? o.rationale
            : typeof o.reasoning === "string"
              ? o.reasoning
              : typeof o.explanation === "string"
                ? o.explanation
                : "",
      };
    }
  }
  return null;
}

// ── The adapter ──────────────────────────────────────────────

/**
 * Ask Jev (`free/jev-1.13`) to arbitrate. Rides the APInex key pool
 * (the Orrery ring + breaker) — the decision endpoint is exclusive
 * to APInex, so the APINEX provider row is used even when another
 * provider is active for chat.
 */
export async function arbitrateDecision(input: ArbitrateInput): Promise<ArbitrateResult> {
  await ensureSeed();
  const { options, criteria, context } = normalizeArbitrateInput(input);

  const apinex = await db.provider.findUnique({ where: { slug: "apinex" } });
  if (!apinex?.baseUrl) {
    throw new JevError("The APInex provider is not configured.", 500, "no-provider");
  }

  const payload = {
    model: JEV_MODEL,
    context,
    options,
    criteria,
  };

  const tried = new Set<string>();
  let lastStatus = 0;

  for (;;) {
    const picked = await pickKey(apinex, tried);
    if (!picked.key) break;
    if (tried.size >= 4) break;
    tried.add(picked.key.id);
    const key = picked.key as BridgeKey;

    let res: Response | null = null;
    try {
      res = await fetch(`${apinex.baseUrl}/decisions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key.keyValue}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      res = null;
    }

    if (!res) {
      continue; // network cut — next key
    }
    if (!res.ok) {
      lastStatus = res.status;
      const cls = classifyStatus(res.status);
      noteFailure(key.id, cls.reason);
      continue;
    }

    const json: unknown = await res.json().catch(() => null);
    if (!json) {
      noteFailure(key.id, "transient");
      continue;
    }
    noteKeySuccess(key.id);
    const normalized = normalizeDecisionResponse(json, options);
    if (!normalized) {
      // A 200 that parses as neither the ensemble shape nor any
      // known fallback — never guess a decision from it.
      throw new JevError(
        "The decision engine returned an unrecognizable answer.",
        502,
        "jev-unparseable"
      );
    }
    return {
      ...normalized,
      servedBy: { key: key.label, model: JEV_MODEL, attempts: tried.size },
    };
  }

  if (lastStatus === 404 || lastStatus === 400) {
    throw new JevError(
      `The upstream has no /decisions endpoint for ${JEV_MODEL} (HTTP ${lastStatus}). The decision engine is unreachable right now.`,
      502,
      "jev-unavailable"
    );
  }
  throw new JevError(
    `Every pooled key failed to reach the decision engine${lastStatus ? ` (last HTTP ${lastStatus})` : ""}.`,
    502,
    "jev-pool-exhausted"
  );
}

function noteFailure(keyId: string, kind: "auth" | "transient"): void {
  noteKeyFailure(keyId, kind);
}
