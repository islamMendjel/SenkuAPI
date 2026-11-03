// Hermes — THE EXOCORE (Run 40): Anthropic Messages ⇄ OpenAI
// translation layer. Claude Code (and every Anthropic-SDK tool) talks
// /v1/messages with content BLOCKS and tool_use/tool_result — a
// different wire dialect than the pooled provider's OpenAI spec.
// This module is the honest translator, not a shim:
//
//   Anthropic → OpenAI (request)
//     system (string | text blocks)        → system message
//     text blocks                          → content text
//     tool_use blocks (assistant)          → tool_calls
//     tool_result blocks (user)            → role:"tool" messages
//     tools [{name, input_schema}]         → function tools
//     tool_choice auto/any/tool/none       → auto/required/named/none
//     max_tokens, stop_sequences, temp…    → the OpenAI twins
//
//   OpenAI → Anthropic (response, JSON and SSE)
//     message.content + message.tool_calls → text + tool_use blocks
//     delta.content                        → content_block_delta (text_delta)
//     delta.tool_calls (indexed, partial)  → content_block_start(tool_use)
//                                            + input_json_delta stream
//     finish_reason                        → stop_reason
//     usage                                → usage (message_delta)
//
// SSE event grammar follows Anthropic's: message_start →
// content_block_start/delta/stop* → message_delta → message_stop,
// each frame `event: <type>\ndata: <json>\n\n`.
//
// No response cache here by design: CLI prompts are huge and
// unique — caching would only pollute the 24h store. Every turn is
// still breaker-protected, rotated and accounted.

import {
  SseAccountant,
  parseOpenAIChunk,
  type OpenAIChunkShape,
} from "./bridge";

// ── Request translation ──────────────────────────────────────

export interface AnthropicBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown; // string | AnthropicBlock[] (tool_result)
}

export interface AnthropicMessage {
  role?: string;
  content?: unknown; // string | AnthropicBlock[]
}

export interface AnthropicBody {
  model?: unknown;
  messages?: AnthropicMessage[];
  system?: unknown; // string | AnthropicBlock[]
  max_tokens?: unknown;
  stream?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  stop_sequences?: unknown;
  tools?: { name?: string; description?: string; input_schema?: unknown }[];
  tool_choice?: { type?: string; name?: string } | null;
}

export interface TranslationResult {
  payload: Record<string, unknown>; // OpenAI chat.completions body
  systemText: string;
  promptText: string;
}

function flattenBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      const block = (b ?? {}) as AnthropicBlock;
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "tool_result") {
        // the model sees the tool's output, whatever shape it came in
        return flattenBlocks(block.content);
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

export function translateAnthropicToOpenAI(
  body: AnthropicBody,
  resolvedModel: string
): TranslationResult {
  const messages: Record<string, unknown>[] = [];

  // system — string or [{type:"text",text}]
  const systemText = flattenBlocks(body.system);
  if (systemText.trim()) {
    messages.push({ role: "system", content: systemText });
  }

  let promptText = "";
  for (const msg of body.messages ?? []) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    if (typeof msg.content === "string") {
      if (msg.content.trim()) {
        messages.push({ role, content: msg.content });
        if (role === "user") promptText += (promptText ? "\n" : "") + msg.content;
      }
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    let text = "";
    const toolCalls: {
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }[] = [];
    const toolResults: Record<string, unknown>[] = [];

    for (const raw of msg.content) {
      const block = (raw ?? {}) as AnthropicBlock;
      if (block.type === "text" && typeof block.text === "string") {
        text += (text ? " " : "") + block.text;
      } else if (block.type === "tool_use" && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments:
              block.input === undefined
                ? "{}"
                : JSON.stringify(block.input ?? {}),
          },
        });
      } else if (block.type === "tool_result" && block.tool_use_id) {
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: flattenBlocks(block.content),
        });
      }
      // image blocks: the pooled free models are text-only — skipped
    }

    if (toolResults.length) {
      messages.push(...toolResults);
    }
    if (text.trim() || toolCalls.length) {
      messages.push({
        role,
        ...(text.trim() ? { content: text } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    }
    if (role === "user" && text.trim()) {
      promptText += (promptText ? "\n" : "") + text;
    }
  }

  // tools
  const tools = (body.tools ?? [])
    .filter((t) => t && typeof t.name === "string")
    .map((t) => ({
      type: "function",
      function: {
        name: t.name as string,
        description: t.description ?? "",
        parameters: (t.input_schema ?? { type: "object", properties: {} }) as unknown,
      },
    }));

  const toolChoice = body.tool_choice?.type;
  const openAiToolChoice = (() => {
    switch (toolChoice) {
      case "auto":
        return "auto";
      case "any":
        return "required";
      case "none":
        return "none";
      case "tool":
        return body.tool_choice?.name
          ? { type: "function", function: { name: body.tool_choice.name } }
          : "auto";
      default:
        return undefined;
    }
  })();

  const payload: Record<string, unknown> = {
    model: resolvedModel,
    messages,
    max_tokens:
      typeof body.max_tokens === "number" && body.max_tokens > 0
        ? Math.min(body.max_tokens, 16_000)
        : 4096,
    stream: body.stream === true,
  };
  if (typeof body.temperature === "number") payload.temperature = body.temperature;
  if (typeof body.top_p === "number") payload.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    payload.stop = body.stop_sequences;
  }
  if (tools.length) payload.tools = tools;
  if (openAiToolChoice !== undefined) payload.tool_choice = openAiToolChoice;

  return { payload, systemText, promptText };
}

// ── Response translation (JSON) ──────────────────────────────

export interface OpenAiJsonResponse {
  choices?: {
    index?: number;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: {
        id: string;
        type?: string;
        function: { name: string; arguments: string };
      }[];
    } | null;
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

export function translateOpenAiJsonToAnthropic(
  json: OpenAiJsonResponse,
  model: string
): Record<string, unknown> {
  const choice = json.choices?.[0];
  const content: Record<string, unknown>[] = [];
  const text = choice?.message?.content ?? "";
  if (text) content.push({ type: "text", text });

  for (const tc of choice?.message?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch {
      input = { _raw: tc.function.arguments };
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }

  const stopReason = (() => {
    switch (choice?.finish_reason) {
      case "length":
        return "max_tokens";
      case "tool_calls":
      case "function_call":
        return "tool_use";
      case "stop_sequence":
        return "stop_sequence";
      default:
        return "end_turn";
    }
  })();

  return {
    id: `msg_hermes_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: json.usage?.prompt_tokens ?? 0,
      output_tokens: json.usage?.completion_tokens ?? 0,
    },
  };
}

// ── Response translation (SSE state machine) ─────────────────

interface ToolBlockState {
  blockIndex: number;
  id: string;
  name: string;
}

/**
 * Incremental OpenAI-chunks → Anthropic-SSE translator. Feed raw
 * upstream bytes; collect the Anthropic event bytes to forward.
 */
export class AnthropicSseTranslator {
  private lineBuf = "";
  private accountant = new SseAccountant(); // text/usage accumulation
  private out: Uint8Array[] = [];
  private started = false;
  private nextBlockIndex = 0;
  private textBlockIndex: number | null = null;
  private toolBlocks = new Map<number, ToolBlockState>();
  private finishReason: string | null = null;
  private readonly model: string;
  private readonly id: string;

  constructor(model: string) {
    this.model = model;
    this.id = `msg_hermes_${Date.now().toString(36)}`;
  }

  private event(type: string, data: unknown): void {
    const body = JSON.stringify(data);
    this.out.push(
      new TextEncoder().encode(`event: ${type}\ndata: ${body}\n\n`)
    );
  }

  private startMessage(): void {
    if (this.started) return;
    this.started = true;
    this.event("message_start", {
      type: "message_start",
      message: {
        id: this.id,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private openTextBlock(): void {
    if (this.textBlockIndex !== null) return;
    this.textBlockIndex = this.nextBlockIndex++;
    this.event("content_block_start", {
      type: "content_block_start",
      index: this.textBlockIndex,
      content_block: { type: "text", text: "" },
    });
  }

  private closeTextBlock(): void {
    if (this.textBlockIndex === null) return;
    this.event("content_block_stop", {
      type: "content_block_stop",
      index: this.textBlockIndex,
    });
    this.textBlockIndex = null;
  }

  /** Feed raw upstream bytes; returns Anthropic event bytes ready
   *  to enqueue to the client. */
  process(bytes: Uint8Array): Uint8Array[] {
    this.out = [];
    this.lineBuf += new TextDecoder().decode(bytes, { stream: true });
    const lines = this.lineBuf.split("\n");
    this.lineBuf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const chunk = parseOpenAIChunk(trimmed.slice(5).trim());
      if (!chunk) continue;
      this.absorb(chunk);
    }
    return this.out;
  }

  private absorb(chunk: OpenAIChunkShape): void {
    // Single accounting feed — text AND usage accumulate exactly once.
    this.accountant.feed(
      new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)
    );
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    if (delta?.content) {
      this.startMessage();
      this.openTextBlock();
      this.event("content_block_delta", {
        type: "content_block_delta",
        index: this.textBlockIndex,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    for (const tc of delta?.tool_calls ?? []) {
      this.startMessage();
      let state = this.toolBlocks.get(tc.index);
      if (!state) {
        // a tool call starts — the text block must close first
        this.closeTextBlock();
        const blockIndex = this.nextBlockIndex++;
        state = {
          blockIndex,
          id: tc.id || `toolu_hermes_${Date.now().toString(36)}_${tc.index}`,
          name: tc.function?.name ?? "",
        };
        this.toolBlocks.set(tc.index, state);
        this.event("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "tool_use", id: state.id, name: state.name, input: {} },
        });
      }
      if (tc.function?.arguments) {
        this.event("content_block_delta", {
          type: "content_block_delta",
          index: state.blockIndex,
          delta: { type: "input_json_delta", partial_json: tc.function.arguments },
        });
      }
    }

    if (choice?.finish_reason) this.finishReason = choice.finish_reason;
  }

  /** Accounting snapshot for the route's UsageEvent — the honest
   *  numbers the upstream reported (or the chars/4 estimate). */
  usageSnapshot(): {
    promptTokens: number;
    completionTokens: number;
    reported: boolean;
  } {
    const u = this.accountant.finish();
    return {
      promptTokens: u.promptTokens,
      completionTokens: u.completionTokens,
      reported: u.usageReported,
    };
  }

  /** Stream ended — emit the closing event sequence. */
  finish(): Uint8Array[] {
    this.out = [];
    this.startMessage();
    this.closeTextBlock();
    for (const state of this.toolBlocks.values()) {
      this.event("content_block_stop", {
        type: "content_block_stop",
        index: state.blockIndex,
      });
    }
    const usage = this.accountant.finish();
    const stopReason = (() => {
      switch (this.finishReason) {
        case "length":
          return "max_tokens";
        case "tool_calls":
        case "function_call":
          return "tool_use";
        case "stop_sequence":
          return "stop_sequence";
        default:
          return "end_turn";
      }
    })();
    this.event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: usage.promptTokens,
        output_tokens: usage.completionTokens,
      },
    });
    this.event("message_stop", { type: "message_stop" });
    return this.out;
  }
}

/** One Anthropic SSE frame — exported for the non-stream path's
 *  error envelopes so even failures speak the right dialect. */
export function anthropicEventBytes(type: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  );
}
