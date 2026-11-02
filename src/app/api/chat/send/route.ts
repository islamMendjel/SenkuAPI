// POST /api/chat/send — streaming (SSE) chat turn through the gateway.
// Events: meta → sources? → delta* → done | error
// Duel turns: meta → duel_start → delta*(lane-tagged) → lane_done×2 → done(duel)
import { NextRequest } from "next/server";
import { sanitizeAttachments } from "@/lib/senku/attachments";
import { runChatTurn, runDuelTurn } from "@/lib/senku/gateway";
import { ensureSeed } from "@/lib/senku/seed";
import type { ChatMessageData, EffortLevel } from "@/lib/senku/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface SendBody {
  chatId?: string | null;
  history?: ChatMessageData[];
  content?: string;
  model?: string;
  search?: boolean;
  temporary?: boolean;
  persistUser?: boolean;
  duel?: boolean;
  challengerModel?: string;
  effort?: EffortLevel;
  /** Attachment records from the composer (already extracted —
   *  rebuilt field-by-field by sanitizeAttachments). */
  attachments?: unknown;
}

/** Only the three dial positions are valid — anything else is
 *  silently treated as the default (medium). */
function normalizeEffort(v: unknown): EffortLevel {
  return v === "fast" || v === "deep" ? v : "medium";
}

export async function POST(req: NextRequest) {
  await ensureSeed();
  const body = (await req.json().catch(() => ({}))) as SendBody;

  // Client's connection (Stop button / tab close / navigation).
  // Aborting this signal cancels the UPSTREAM generation at the
  // source — without it, the provider keeps generating tokens into
  // a dead stream and drains the key pool.
  const clientSignal = req.signal;
  if (clientSignal) {
    clientSignal.addEventListener(
      "abort",
      () => console.log("[chat/send] client disconnected — cancelling upstream generation"),
      { once: true }
    );
  }

  const content = (body.content ?? "").trim();
  if (!content) {
    return new Response(JSON.stringify({ error: "content is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const history: ChatMessageData[] = Array.isArray(body.history)
    ? body.history
        .filter(
          (m) =>
            m &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string"
        )
        .slice(-20)
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
          // History rows may carry their attachment records (from a
          // previous turn in this chat) — sanitized the same way.
          ...(m.role === "user" && m.attachments
            ? { attachments: sanitizeAttachments(m.attachments) }
            : {}),
        }))
    : [];
  const attachments = sanitizeAttachments(body.attachments);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (ev: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          // client disconnected
        }
      };
      try {
        if (body.duel === true) {
          await runDuelTurn({
            chatId: body.chatId ?? null,
            history,
            content,
            model: body.model ?? "",
            challenger: (body.challengerModel ?? "").trim(),
            search: body.search === true,
            temporary: body.temporary === true,
            persistUser: body.persistUser !== false,
            effort: normalizeEffort(body.effort),
            attachments,
            signal: clientSignal,
            emit: (ev) => emit(ev as Record<string, unknown>),
          });
        } else {
          await runChatTurn({
            chatId: body.chatId ?? null,
            history,
            content,
            model: body.model ?? "",
            search: body.search === true,
            temporary: body.temporary === true,
            persistUser: body.persistUser !== false,
            effort: normalizeEffort(body.effort),
            attachments,
            signal: clientSignal,
            emit: (ev) => emit(ev as Record<string, unknown>),
          });
        }
      } catch (e) {
        const err = e as Error & { code?: string };
        emit({ type: "error", message: err.message, code: err.code ?? "error" });
      } finally {
        try {
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
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
