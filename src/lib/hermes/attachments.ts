// Hermes — attachment extraction (server-side only).
// REAL file understanding: the gateway reads the file's content and
// sends the extract with the message. Three extraction engines:
//   text  — UTF-8 decode (plain text, markdown, code, csv, json…)
//   pdf   — text-layer extraction via unpdf (serverless pdf.js)
//   image — a pooled VISION pass (z-ai-web-dev-sdk createVision):
//           OCR every visible word + describe the visual content
// Every record is HONEST: `chars`/`totalChars`/`truncated` say
// exactly what the model received, and `method` names the engine.
// A file that cannot be read is NOT sent — the model never sees a
// filename it wasn't given the content of.

import { extractText, getDocumentProxy } from "unpdf";
import ZAI from "z-ai-web-dev-sdk";
import type { AttachmentRecord } from "./types";

// ── Limits (extraction honesty, enforced server-side) ────────
export const ATTACHMENT_MAX_FILES = 5;
export const ATTACHMENT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // text/pdf
export const ATTACHMENT_MAX_IMAGE_BYTES = 6 * 1024 * 1024;
/** Per-file extract cap — what the model receives. */
export const ATTACHMENT_TEXT_CAP = 20_000;
export const ATTACHMENT_IMAGE_CAP = 4_000;
/** Whole-message cap across all files (later files get trimmed). */
export const ATTACHMENT_TOTAL_CAP = 60_000;

export type ExtractSuccess = { ok: true; record: AttachmentRecord };
export type ExtractFailure = { ok: false; name: string; error: string };
export type ExtractOutcome = ExtractSuccess | ExtractFailure;

/** Extensions treated as readable plain text (beyond text/* mimes). */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml",
  "toml", "ini", "cfg", "conf", "env", "log", "xml", "html", "htm",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "rb", "go", "rs", "java",
  "kt", "kts", "c", "h", "cpp", "hpp", "cs", "swift", "php", "sh", "bash",
  "zsh", "fish", "sql", "graphql", "gql", "css", "scss", "sass", "less",
  "vue", "svelte", "astro", "dockerfile", "makefile", "gitignore",
  "properties", "lock", "diff", "patch", "r", "m", "pl", "lua", "dart",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Classify an upload into an extraction engine (null = unsupported). */
export function classifyAttachment(
  name: string,
  mime: string
): "text" | "pdf" | "image" | null {
  const ext = extensionOf(name);
  const mimeBase = (mime || "").split(";")[0].trim().toLowerCase();
  if (mimeBase === "application/pdf" || ext === "pdf") return "pdf";
  if (mimeBase.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) return "image";
  if (
    mimeBase.startsWith("text/") ||
    TEXT_EXTENSIONS.has(ext) ||
    // No extension + no mime hint: give text a chance (decode check
    // follows — binary junk fails the UTF-8 sanity gate).
    ext === ""
  ) {
    return "text";
  }
  return null;
}

/** Binary sanity gate — rejects decode of executables/archives that
 *  slipped through with a text-ish guess. */
function looksLikeText(sample: string): boolean {
  if (!sample) return false;
  let controls = 0;
  const n = Math.min(sample.length, 4000);
  for (let i = 0; i < n; i++) {
    const c = sample.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue; // tab/newline
    if (c < 32 || c === 65533) controls++; // control / replacement char
  }
  return controls / n < 0.02;
}

function capExtract(raw: string, cap: number): {
  extract: string;
  chars: number;
  totalChars: number;
  truncated: boolean;
} {
  const total = raw.length;
  if (total <= cap) {
    return { extract: raw, chars: total, totalChars: total, truncated: false };
  }
  // Cut on a line boundary near the cap when one is close by, so the
  // model never receives a line that was cut mid-sentence silently.
  let cut = raw.lastIndexOf("\n", cap);
  if (cut < cap * 0.8) cut = cap;
  const extract =
    raw.slice(0, cut).trimEnd() +
    `\n\n[… extract truncated — ${cut} of ${total} characters included]`;
  return { extract, chars: extract.length, totalChars: total, truncated: true };
}

/**
 * Read one uploaded file into an AttachmentRecord. Never throws —
 * unreadable files come back as typed failures and are NOT sent.
 */
export async function extractAttachment(input: {
  name: string;
  mime: string;
  bytes: Uint8Array;
}): Promise<ExtractOutcome> {
  const { name, mime } = input;
  const kind = classifyAttachment(name, mime);
  if (!kind) {
    return {
      ok: false,
      name,
      error: `Unsupported file type (${mime || extensionOf(name) || "unknown"}) — only text, code, PDF and image files can be read.`,
    };
  }

  const sizeLimit =
    kind === "image" ? ATTACHMENT_MAX_IMAGE_BYTES : ATTACHMENT_MAX_UPLOAD_BYTES;
  if (input.bytes.byteLength > sizeLimit) {
    return {
      ok: false,
      name,
      error: `File is ${(input.bytes.byteLength / 1024 / 1024).toFixed(1)} MB — the limit is ${Math.round(sizeLimit / 1024 / 1024)} MB for ${kind === "image" ? "images" : "documents"}.`,
    };
  }

  try {
    if (kind === "text") {
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(
        input.bytes
      );
      if (!looksLikeText(decoded)) {
        return {
          ok: false,
          name,
          error: "File doesn't look like readable text (binary content?).",
        };
      }
      if (!decoded.trim()) {
        return { ok: false, name, error: "File is empty." };
      }
      const capped = capExtract(decoded.replace(/\r\n/g, "\n"), ATTACHMENT_TEXT_CAP);
      return {
        ok: true,
        record: {
          name, mime: mime || "text/plain", kind, method: "text-layer",
          chars: capped.chars, totalChars: capped.totalChars,
          truncated: capped.truncated, extract: capped.extract,
        },
      };
    }

    if (kind === "pdf") {
      const pdf = await getDocumentProxy(input.bytes);
      const { text } = await extractText(pdf, { mergePages: true });
      const raw = (Array.isArray(text) ? text.join("\n\n") : text).trim();
      if (!raw) {
        return {
          ok: false,
          name,
          error: "No text layer found — scanned or image-only PDFs aren't supported yet.",
        };
      }
      const capped = capExtract(raw.replace(/\r\n/g, "\n"), ATTACHMENT_TEXT_CAP);
      return {
        ok: true,
        record: {
          name, mime: "application/pdf", kind, method: "text-layer",
          chars: capped.chars, totalChars: capped.totalChars,
          truncated: capped.truncated, extract: capped.extract,
        },
      };
    }

    // image → pooled VISION pass (OCR + visual description)
    const base64 = Buffer.from(input.bytes).toString("base64");
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.createVision({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Read this image for someone who will ask questions about it. " +
                "(1) Transcribe ALL text visible in the image, verbatim, preserving " +
                "line breaks and table layout with plain-text alignment. " +
                "(2) Then on a new line starting with '--- VISUAL ---' describe in " +
                "1-3 sentences what the image shows (chart type, objects, layout, " +
                "colors that carry meaning). Do not interpret beyond what is visible; " +
                "if some text is illegible, write [illegible] where it appears.",
            },
            {
              type: "image_url",
              image_url: { url: `data:${mime || "image/png"};base64,${base64}` },
            },
          ],
        },
      ],
      thinking: { type: "disabled" },
    });
    const raw: string = completion?.choices?.[0]?.message?.content ?? "";
    if (!raw.trim()) {
      return { ok: false, name, error: "Vision pass returned nothing readable." };
    }
    const capped = capExtract(raw.trim(), ATTACHMENT_IMAGE_CAP);
    return {
      ok: true,
      record: {
        name, mime: mime || "image/png", kind, method: "vision",
        chars: capped.chars, totalChars: capped.totalChars,
        truncated: capped.truncated, extract: capped.extract,
      },
    };
  } catch (e) {
    return {
      ok: false,
      name,
      error: `Could not read the file (${(e as Error).message || "extraction failed"}).`,
    };
  }
}

// ── Inbound sanitization (the send route must never trust the
//    client's JSON — records are rebuilt field-by-field) ───────

const KINDS = new Set(["text", "pdf", "image"]);
const METHODS = new Set(["text-layer", "vision"]);

/** Rebuild one AttachmentRecord from untrusted JSON, or null. */
export function sanitizeAttachmentRecord(
  raw: unknown,
  index: number
): AttachmentRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name =
    typeof r.name === "string" ? r.name.trim().slice(0, 120) : `file-${index + 1}`;
  const mime = typeof r.mime === "string" ? r.mime.trim().slice(0, 80) : "";
  const kind = typeof r.kind === "string" && KINDS.has(r.kind) ? r.kind : null;
  const method =
    typeof r.method === "string" && METHODS.has(r.method) ? r.method : "text-layer";
  const extract = typeof r.extract === "string" ? r.extract.slice(0, ATTACHMENT_TEXT_CAP + 400) : "";
  if (!kind || !extract.trim()) return null;
  const totalChars =
    typeof r.totalChars === "number" && Number.isFinite(r.totalChars)
      ? Math.max(0, Math.floor(r.totalChars))
      : extract.length;
  return {
    name,
    mime,
    kind,
    method,
    chars: extract.length,
    totalChars,
    truncated: r.truncated === true,
    extract,
  };
}

/** Sanitize the whole attachments array from a request body. */
export function sanitizeAttachments(
  raw: unknown
): AttachmentRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: AttachmentRecord[] = [];
  let total = 0;
  for (let i = 0; i < raw.length && records.length < ATTACHMENT_MAX_FILES; i++) {
    const rec = sanitizeAttachmentRecord(raw[i], i);
    if (!rec) continue;
    // Whole-message cap: later files are trimmed (with an honest
    // in-band note) rather than silently dropped.
    const room = Math.max(0, ATTACHMENT_TOTAL_CAP - total);
    if (room <= 200) break;
    if (rec.extract.length > room) {
      const cut = rec.extract.lastIndexOf("\n", room);
      rec.extract =
        rec.extract.slice(0, cut > room * 0.8 ? cut : room).trimEnd() +
        `\n\n[… extract trimmed to fit this message's attachment budget]`;
      rec.chars = rec.extract.length;
      rec.truncated = true;
    }
    total += rec.extract.length;
    records.push(rec);
  }
  return records;
}

// ── Prompt injection ─────────────────────────────────────────
// Mirrors searchContextBlock: a clearly-delimited block appended to
// the user turn, carrying its own instructions. The system prompt
// stays byte-identical, so turns without attachments are completely
// unchanged (cache included).

function describeFile(a: AttachmentRecord): string {
  const what =
    a.kind === "pdf"
      ? "PDF text layer"
      : a.kind === "image"
        ? "vision pass (OCR + visual description)"
        : "file contents";
  const size = a.truncated
    ? `first ${a.chars} of ${a.totalChars} characters`
    : `${a.chars} characters`;
  return `${what}, ${size}`;
}

export function attachmentContextBlock(atts: AttachmentRecord[]): string {
  if (!atts.length) return "";
  const files = atts
    .map(
      (a, i) =>
        `[File ${i + 1}: ${a.name}] — ${describeFile(a)}\n` +
        `${a.extract}\n[End of file: ${a.name}]`
    )
    .join("\n\n");
  return (
    `\n\n--- ATTACHED FILES — the user's own material, read by the gateway ---\n` +
    `Each file below was read by the gateway (${atts
      .map((a) => `${a.name}: ${a.method}`)
      .join(", ")}). ` +
    `This is the user's provided material: treat it as authoritative input about ` +
    `THEIR data — unlike web results, it needs no external verification. Refer to ` +
    `files by name. If an extract says it was truncated or trimmed, more content ` +
    `exists than you can see — say so rather than guessing at it. If the answer ` +
    `cannot be found in these files, say that plainly.\n\n` +
    files
  );
}
