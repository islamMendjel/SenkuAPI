// Hermes — Run 39, THE FORK: the conversation is a TREE, not a tape.
// Every message chains to its parent (parentMessageId); editing a
// message creates a NEW SIBLING under the same parent and the old
// turn — with ALL of its descendants — survives in the database,
// one ‹ › click away. Nothing is ever deleted.
//
// This module is the single source of truth for tree mechanics:
//   resolveActivePath — which messages the timeline displays
//   nextChildSlot     — parent + branchIndex for every new row
//   advanceLeaf       — the chat's displayed branch follows new turns
//   serializeRow      — one wire shape for every message read
//
// Linear-era rows (parentMessageId null) chain by createdAt through
// `linkLinearEra`, so pre-FORK chats resolve identically — no
// backfill dependency, no migration cliff.

import { db } from "@/lib/db";

export interface TreeRow {
  id: string;
  chatId: string;
  role: string;
  content: string;
  model: string | null;
  provider: string | null;
  keyLabel: string | null;
  tokens: number;
  tokensEstimated: boolean;
  cached: boolean;
  sources: string | null;
  attachments: string | null;
  effort: string | null;
  altContent: string | null;
  altModel: string | null;
  variants: string | null;
  variantIndex: number | null;
  image: string | null;
  ritualId: string | null;
  parentMessageId: string | null;
  branchIndex: number;
  createdAt: Date;
}

/** Linear-era safety net: any row with a null parent that is NOT the
 *  chat's oldest message chains to the row created just before it,
 *  so pre-FORK conversations resolve as one path without a backfill.
 *  Runs ONLY on pure linear-era chats (every row parent-null) — in a
 *  tree-structured chat a null parent means a legitimate ROOT FORK
 *  (an edit of the first message) and must never be linked. */
function linkLinearEra(rows: TreeRow[]): void {
  if (rows.some((r) => r.parentMessageId !== null)) return; // tree-structured
  const byAsc = [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
  );
  for (let i = 1; i < byAsc.length; i++) {
    if (byAsc[i].parentMessageId === null) {
      byAsc[i].parentMessageId = byAsc[i - 1].id;
    }
  }
}

/** Pick the leaf the timeline displays: the chat's stored pointer when
 *  it still exists, otherwise the newest row (linear era / fresh chat). */
function pickLeaf(rows: TreeRow[], activeLeafId: string | null): TreeRow {
  if (activeLeafId) {
    const stored = rows.find((r) => r.id === activeLeafId);
    if (stored) return stored;
  }
  return rows.reduce((newest, r) =>
    r.createdAt.getTime() > newest.createdAt.getTime() ? r : newest
  );
}

/** The wire metadata the timeline needs to draw ‹ k/N › switchers:
 *  where this message sits among its siblings and how many there are. */
export interface BranchMeta {
  branchIndex: number;
  siblingCount: number;
  siblingPosition: number;
}

export interface ResolvedPath {
  /** the displayed conversation, root → leaf */
  path: TreeRow[];
  /** per-message ‹ k/N › metadata, aligned with `path` */
  meta: BranchMeta[];
  /** the leaf the resolution started from (kept on the chat row) */
  leafId: string;
}

/** Resolve the ACTIVE PATH through a chat's message tree: walk up
 *  from the leaf, then annotate every fork on the way. One query,
 *  O(n) work — chats are human-scale. */
export function resolveActivePath(
  rows: TreeRow[],
  activeLeafId: string | null
): ResolvedPath | null {
  if (rows.length === 0) return null;
  linkLinearEra(rows);
  const leaf = pickLeaf(rows, activeLeafId);

  const byId = new Map(rows.map((r) => [r.id, r]));
  // children grouped by parent (null = root slot), sibling order = branchIndex
  const children = new Map<string | null, TreeRow[]>();
  for (const r of rows) {
    const key = r.parentMessageId;
    const list = children.get(key) ?? [];
    list.push(r);
    children.set(key, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.branchIndex - b.branchIndex || a.createdAt.getTime() - b.createdAt.getTime());
  }

  // walk UP from the leaf
  const chain: TreeRow[] = [];
  const seen = new Set<string>();
  let cursor: TreeRow | null = leaf;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.parentMessageId ? byId.get(cursor.parentMessageId) ?? null : null;
  }
  chain.reverse(); // root → leaf

  // annotate: for each node, its position among its parent's children
  const meta: BranchMeta[] = chain.map((r) => {
    const siblings = children.get(r.parentMessageId) ?? [r];
    const pos = Math.max(
      0,
      siblings.findIndex((s) => s.id === r.id)
    );
    return {
      branchIndex: r.branchIndex,
      siblingCount: siblings.length,
      siblingPosition: pos,
    };
  });

  return { path: chain, meta, leafId: leaf.id };
}

/** Where the next row under `parentId` goes: the parent pointer plus
 *  the branchIndex (sibling count — indexes are dense 0..N-1). */
export async function nextChildSlot(
  chatId: string,
  parentId: string | null
): Promise<{ parentMessageId: string | null; branchIndex: number }> {
  const siblingCount = await db.message.count({
    where: { chatId, parentMessageId: parentId },
  });
  return { parentMessageId: parentId, branchIndex: siblingCount };
}

/** Linear-era self-heal: chains null-parent rows by createdAt — the
 *  one-time backfill, run lazily the first time a pre-FORK chat is
 *  forked or navigated. Runs ONLY when the chat is PURE linear era
 *  (every row parent-null): any non-null parent means the chat is
 *  already tree-structured and its null rows are legitimate ROOT
 *  FORKS — linking them would corrupt the tree. */
export async function ensureChatTree(chatId: string): Promise<void> {
  const rows = await db.message.findMany({
    where: { chatId },
    orderBy: { createdAt: "asc" },
    select: { id: true, parentMessageId: true },
  });
  if (rows.some((r) => r.parentMessageId !== null)) return; // tree-structured
  let prevId: string | null = null;
  for (const r of rows) {
    if (prevId !== null) {
      await db.message
        .update({ where: { id: r.id }, data: { parentMessageId: prevId } })
        .catch(() => {});
    }
    prevId = r.id;
  }
}

/** The chat's current leaf: the stored pointer when valid, else the
 *  newest row. Returns null only for a chat with no messages. */
export async function currentLeaf(
  chatId: string
): Promise<{ id: string | null; activeLeafId: string | null }> {
  const chat = await db.chat.findUnique({
    where: { id: chatId },
    select: { activeLeafId: true },
  });
  const newest = await db.message.findFirst({
    where: { chatId },
    orderBy: { createdAt: "desc" },
  });
  const stored = chat?.activeLeafId
    ? await db.message.findFirst({
        where: { id: chat.activeLeafId, chatId },
        select: { id: true },
      })
    : null;
  return {
    id: stored?.id ?? newest?.id ?? null,
    activeLeafId: chat?.activeLeafId ?? null,
  };
}

/** The displayed branch follows every persisted turn: the just-saved
 *  row becomes the leaf. */
export async function advanceLeaf(
  chatId: string,
  messageId: string
): Promise<void> {
  await db.chat
    .update({ where: { id: chatId }, data: { activeLeafId: messageId } })
    .catch(() => {});
}

/** Deepest, newest descendant of a branch root: the path the timeline
 *  shows when the user flips back to an older branch — inside it,
 *  the latest continuation wins (same rule everywhere). */
export async function deepestDescendant(rootId: string): Promise<string> {
  let cursor = rootId;
  for (;;) {
    const kid = await db.message.findFirst({
      where: { parentMessageId: cursor },
      orderBy: [{ branchIndex: "desc" }, { createdAt: "desc" }],
      select: { id: true },
    });
    if (!kid) return cursor;
    cursor = kid.id;
  }
}

/** One wire shape for every message the API returns — JSON columns
 *  parsed, dates ISO'd, tree metadata attached. */
export function serializeRow(r: TreeRow, meta?: BranchMeta) {
  return {
    id: r.id,
    chatId: r.chatId,
    role: r.role,
    content: r.content,
    model: r.model,
    provider: r.provider,
    keyLabel: r.keyLabel,
    tokens: r.tokens,
    tokensEstimated: r.tokensEstimated,
    cached: r.cached,
    sources: r.sources ? JSON.parse(r.sources) : null,
    attachments: r.attachments ? JSON.parse(r.attachments) : null,
    effort: r.effort,
    altContent: r.altContent,
    altModel: r.altModel,
    variants: r.variants ? JSON.parse(r.variants) : null,
    variantIndex: r.variantIndex,
    image: r.image ? JSON.parse(r.image) : null,
    ritualId: r.ritualId,
    ...(meta ?? {}),
    createdAt: r.createdAt.toISOString(),
  };
}
