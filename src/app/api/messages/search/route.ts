// Hermes — Run 26: full-text message search ("THE MEMORY, SEARCHABLE").
//
// GET /api/messages/search?q=…
// Searches the CONTENT of every message in every SAVED conversation
// (temporary chats are excluded — they are scratch space, not memory).
// Returns compact snippets with exact match offsets so the client can
// highlight without ever shipping or parsing HTML (XSS-safe by design).
//
// The response powers the ⌘K palette's "In your messages" group:
// pick a hit → its chat opens → the matched message scrolls into view
// and flashes once.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const MIN_QUERY = 2;
const MAX_HITS = 30;
/** characters of context kept on each side of the match */
const SNIPPET_CONTEXT = 90;

interface SearchHit {
  messageId: string;
  chatId: string;
  chatTitle: string;
  role: string;
  model: string | null;
  createdAt: string;
  snippet: string;
  matchStart: number;
  matchEnd: number;
}

/** Build a single-line snippet around the FIRST case-insensitive
 *  match of `query` in `content`. Returns null when the match can't
 *  be located (SQLite `contains` is case-insensitive for ASCII, so a
 *  differing-case miss is possible for non-ASCII queries — we then
 *  fall back to the content head so the row is still useful). */
function buildSnippet(
  content: string,
  query: string
): { snippet: string; matchStart: number; matchEnd: number } {
  // collapse all whitespace runs to single spaces — message content
  // is markdown with hard wraps; a search snippet must read in line
  const flat = content.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) {
    const head = flat.slice(0, SNIPPET_CONTEXT * 2);
    return { snippet: head, matchStart: -1, matchEnd: -1 };
  }
  const from = Math.max(0, at - SNIPPET_CONTEXT);
  const to = Math.min(flat.length, at + query.length + SNIPPET_CONTEXT);
  const snippet =
    (from > 0 ? "… " : "") + flat.slice(from, to) + (to < flat.length ? " …" : "");
  const matchStart = (from > 0 ? 2 : 0) + (at - from);
  return { snippet, matchStart, matchEnd: matchStart + query.length };
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < MIN_QUERY) {
    return NextResponse.json(
      { error: "q must be at least 2 characters" },
      { status: 400 }
    );
  }

  const rows = await db.message.findMany({
    where: { content: { contains: q }, chat: { isTemporary: false } },
    include: { chat: { select: { title: true, isTemporary: true } } },
    orderBy: { createdAt: "desc" },
    take: MAX_HITS,
  });

  const results: SearchHit[] = rows.map((r) => {
    const { snippet, matchStart, matchEnd } = buildSnippet(r.content, q);
    return {
      messageId: r.id,
      chatId: r.chatId,
      chatTitle: r.chat.title,
      role: r.role,
      model: r.model,
      createdAt: r.createdAt.toISOString(),
      snippet,
      matchStart,
      matchEnd,
    };
  });

  return NextResponse.json({ query: q, count: results.length, results });
}
