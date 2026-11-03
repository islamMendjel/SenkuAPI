// Hermes — chat export (Run 15).
// Builds clean Markdown / JSON transcripts of a conversation and
// hands them to the browser as a download. Pure string work — no
// server round-trip of its own (the caller supplies the messages,
// either from the live store for the open chat or from
// GET /api/chats/[id] for any other).

import type { AttachmentRecord, ImageRef, SearchSource } from "@/lib/hermes/types";

/** A message in a shape both the live store and the persisted API
 *  response can be mapped onto without lossy coercion. */
export interface ExportMessage {
  role: string;
  content: string;
  model?: string | null;
  provider?: string | null;
  keyLabel?: string | null;
  tokens?: number | null;
  cached?: boolean | null;
  servedBy?: string | null;
  createdAt?: string | null;
  sources?: SearchSource[] | null;
  attachments?: AttachmentRecord[] | null;
  /** Run 22 — forged image on assistant messages. */
  image?: ImageRef | null;
}

export interface ExportMeta {
  model: string;
  provider: string;
  createdAt: string;
}

/** Title → filesystem-safe base name ("My chat: v2!" → "My chat v2"). */
export function safeFilename(title: string): string {
  const base = title
    .replace(/[^\w\d\- ]+/g, "")
    .trim()
    .replace(/\s+/g, " ");
  return (base || "chat").slice(0, 60);
}

/** Trigger a browser download of `text` without leaving the page. */
export function downloadText(
  filename: string,
  text: string,
  mime: string
): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the click time to hand the blob to the download manager
  // before the URL is revoked.
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

/** Render a conversation as a clean, readable Markdown document:
 *  headings per turn, attachment + source provenance, and a small
 *  metadata line under each assistant reply (tokens · provider ·
 *  cached) — the same honesty the in-app timeline shows. */
export function chatToMarkdown(
  title: string,
  messages: ExportMessage[],
  meta: ExportMeta
): string {
  const out: string[] = [];
  const when = new Date().toISOString().slice(0, 10);

  out.push(`# ${title}`, "");
  out.push(
    `> Exported from Hermes · ${when} · ${messages.length} message${
      messages.length === 1 ? "" : "s"
    } · ${meta.model} (${meta.provider})`,
    "",
    "---",
    ""
  );

  for (const m of messages) {
    if (m.role === "user") {
      out.push("## You", "", m.content, "");
      if (m.attachments?.length) {
        for (const a of m.attachments) {
          out.push(
            `> Attachment: **${a.name}** — ${a.kind}, ${a.chars.toLocaleString()} chars read${
              a.truncated ? " (truncated)" : ""
            } via ${a.method}`
          );
        }
        out.push("");
      }
    } else if (m.role === "assistant") {
      out.push(`## Assistant — ${m.model ?? "model"}`, "", m.content, "");
      // Run 22 — a forged image exports as a real markdown image
      // pointing at the local file route (the bytes stay on disk).
      if (m.image) {
        out.push(
          `![Generated image](/api/image/file/${m.image.id})`,
          ""
        );
      }
      const bits: string[] = [];
      if (m.tokens) bits.push(`${m.tokens.toLocaleString()} tokens`);
      if (m.provider) bits.push(`via ${m.provider}`);
      if (m.cached) bits.push("served from cache");
      if (bits.length) out.push(`_${bits.join(" · ")}_`, "");
      if (m.sources?.length) {
        out.push("**Sources:**");
        for (const s of m.sources) {
          out.push(`- [${s.title}](${s.url})${s.dateHint ? ` — ${s.dateHint}` : ""}`);
        }
        out.push("");
      }
    } else {
      out.push(`## ${m.role}`, "", m.content, "");
    }
    out.push("---", "");
  }

  return out.join("\n");
}
