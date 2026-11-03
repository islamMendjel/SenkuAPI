// POST /api/decisions — THE EXOCORE (Run 40): Jev AI arbitration
// exposed to the UI and the agent loop.
//
//   curl -X POST http://localhost:3000/api/decisions \
//     -H "Content-Type: application/json" \
//     -d '{"options":["search the web","run the calculator"],"criteria":"fastest path to a dated answer"}'
//
// The response is a STRUCTURED arbitration — never a guessed one:
//   { decision, ranking: [{option, score}], rationale, servedBy }
// Upstream unreachable / unparseable → a coded 502, honestly.

import {
  JEV_MODEL,
  JevError,
  arbitrateDecision,
  normalizeArbitrateInput,
} from "@/lib/agent/decisions";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  return Response.json({
    endpoint: "/api/decisions",
    method: "POST",
    model: JEV_MODEL,
    body: {
      options: "string[] — 2..8 mutually exclusive paths",
      criteria: "string — the decision rule",
      context: "string? — background the arbiter should weigh",
    },
    returns: {
      decision: "string — the chosen option, or the ensemble's classification",
      decisionBasis: '"option-match" | "ensemble-classification" — which world you are in',
      ranking: "[{option, score?}] — taxonomy probabilities when it classifies",
      assessment: "{ uncertainty, isSafe, category, complexity } — the full ensemble verdict",
      rationale: "string — the assessment in one line",
      servedBy: "{ key, model, attempts }",
    },
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    options?: unknown;
    criteria?: unknown;
    context?: unknown;
  } | null;

  if (!body) {
    return Response.json({ error: "a JSON body is required" }, { status: 400 });
  }

  try {
    // Normalize first so 400s are precise and cheap.
    const normalized = normalizeArbitrateInput({
      options: (body.options ?? []) as string[],
      criteria: (body.criteria ?? "") as string,
      context: (body.context ?? "") as string,
    });
    const result = await arbitrateDecision(normalized);
    return Response.json(result);
  } catch (err) {
    if (err instanceof JevError) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    return Response.json(
      { error: "The decision engine failed unexpectedly.", code: "jev-crash" },
      { status: 500 }
    );
  }
}
