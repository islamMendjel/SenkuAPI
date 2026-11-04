// Senku Brain Tree Service (Microservice Domain Entrypoint)
// Non-destructive message branching ("The Fork"), SQLite state management,
// active path resolution, and tree traversal.

import { db } from "@/lib/db";
import {
  resolveActivePath,
  nextChildSlot,
  advanceLeaf,
  serializeRow,
  type TreeRow,
  type BranchMeta,
  type ResolvedPath,
} from "@/lib/hermes/tree";
import type {
  IBrainTreeService,
  TreePathResult,
  BranchSlot,
} from "./types";
import type { ChatMessageData } from "@/lib/hermes/types";

export * from "./types";
export {
  resolveActivePath,
  nextChildSlot,
  advanceLeaf,
  serializeRow,
  type TreeRow,
  type BranchMeta,
  type ResolvedPath,
};

class BrainTreeServiceImpl implements IBrainTreeService {
  async resolvePath(chatId: string, leafId?: string | null): Promise<TreePathResult> {
    const chat = await db.chat.findUnique({
      where: { id: chatId },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!chat || chat.messages.length === 0) {
      return { messages: [], activeLeafId: null, totalTurns: 0 };
    }

    const rows: TreeRow[] = chat.messages.map((m) => ({
      ...m,
      tokensEstimated: Boolean(m.tokensEstimated),
      cached: Boolean(m.cached),
    }));

    const resolved = resolveActivePath(rows, leafId ?? chat.activeLeafId);
    if (!resolved) {
      return { messages: [], activeLeafId: null, totalTurns: rows.length };
    }

    const serialized: ChatMessageData[] = resolved.path.map((r, i) =>
      serializeRow(r, resolved.meta[i]) as unknown as ChatMessageData
    );

    return {
      messages: serialized,
      activeLeafId: resolved.leafId,
      totalTurns: rows.length,
    };
  }

  async nextSlot(chatId: string, parentId?: string | null): Promise<BranchSlot> {
    return nextChildSlot(chatId, parentId ?? null);
  }

  async advanceActiveLeaf(chatId: string, leafId: string): Promise<void> {
    await advanceLeaf(chatId, leafId);
  }

  async switchSibling(
    chatId: string,
    messageId: string,
    targetIndex: number
  ): Promise<TreePathResult> {
    const targetMsg = await db.message.findUnique({
      where: { id: messageId },
    });
    if (!targetMsg) {
      throw new Error(`Message ${messageId} not found.`);
    }

    // Find siblings under same parent
    const siblings = await db.message.findMany({
      where: {
        chatId,
        parentMessageId: targetMsg.parentMessageId,
      },
      orderBy: { branchIndex: "asc" },
    });

    const chosen = siblings.find((s) => s.branchIndex === targetIndex) ?? siblings[0];
    if (!chosen) {
      throw new Error(`Sibling at index ${targetIndex} not found.`);
    }

    // Find deepest descendant under chosen sibling
    const allChatMsgs = await db.message.findMany({
      where: { chatId },
      orderBy: { createdAt: "asc" },
    });

    const rows: TreeRow[] = allChatMsgs.map((m) => ({
      ...m,
      tokensEstimated: Boolean(m.tokensEstimated),
      cached: Boolean(m.cached),
    }));

    // Follow descendants to the newest leaf
    let currentId = chosen.id;
    while (true) {
      const children = rows.filter((r) => r.parentMessageId === currentId);
      if (children.length === 0) break;
      const newest = children.reduce((a, b) =>
        b.createdAt.getTime() > a.createdAt.getTime() ? b : a
      );
      currentId = newest.id;
    }

    await advanceLeaf(chatId, currentId);
    return this.resolvePath(chatId, currentId);
  }

  async getSiblingCount(chatId: string, parentId: string | null): Promise<number> {
    return db.message.count({
      where: {
        chatId,
        parentMessageId: parentId,
      },
    });
  }
}

export const brainTree = new BrainTreeServiceImpl();
