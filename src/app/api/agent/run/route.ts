// POST /api/agent/run — THE EXOCORE (Run 40): the agent loop as a
// live SSE stream. Each event is one honest beat of the run:
//
//   data: {"type":"turn","turn":1,"maxTurns":5}
//   data: {"type":"tool_call","tool":"calculator","args":{…}}
//   data: {"type":"tool_result","tool":"calculator","ok":true,"summary":"… = 8,344,163,259"}
//   data: {"type":"final","content":"…"}
//   data: [DONE]
//
// The UI (/agent slash command) renders the trace lines live in the
// assistant bubble and the final content below them.

import { runAgentTask } from "@/lib/agent/orchestrator";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PROMPT_MAX_CHARS = 4000;

export async function GET() {
  return Response.json({
    endpoint: "/api/agent/run",
    method: "POST",
    body: { prompt: "string (≤4000 chars)", model: "string? (must be in the active provider's roster)", maxTurns: "number? (1-8, default 5)" },
    stream: "SSE — status | turn | tool_call | tool_result | final | error, then [DONE]",
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    prompt?: unknown;
    model?: unknown;
    maxTurns?: unknown;
  } | null;

  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }
  if (prompt.length > PROMPT_MAX_CHARS) {
    return Response.json({ error: `prompt is too long (max ${PROMPT_MAX_CHARS} chars)` }, { status: 413 });
  }
  const model = typeof body?.model === "string" && body.model ? body.model : undefined;
  const maxTurns =
    typeof body?.maxTurns === "number" && Number.isFinite(body.maxTurns)
      ? Math.round(body.maxTurns)
      : undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      try {
        await runAgentTask({
          prompt,
          model,
          maxTurns,
          signal: req.signal,
          onEvent: (ev) => {
            try {
              send(ev);
            } catch {
              // controller already closed
            }
          },
        });
      } catch (e) {
        const err = e as Error;
        if (err.name === "AbortError") {
          send({ type: "error", message: "Agent run stopped." });
        } else {
          send({ type: "error", message: err.message || "The agent run failed." });
        }
      } finally {
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
