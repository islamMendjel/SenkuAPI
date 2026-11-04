// Senku Brain Tree — Domain Contracts and Types.
// Non-destructive message branching, leaf resolution, sibling switching,
// and state persistence for tree conversations.

import type { TreeRow, BranchMeta } from "@/lib/hermes/tree";
import type { ChatMessageData } from "@/lib/hermes/types";

export interface TreePathResult {
  messages: ChatMessageData[];
  activeLeafId: string | null;
  totalTurns: number;
}

export interface BranchSlot {
  parentMessageId: string | null;
  branchIndex: number;
}

export interface IBrainTreeService {
  resolvePath(chatId: string, leafId?: string | null): Promise<TreePathResult>;
  nextSlot(chatId: string, parentId?: string | null): Promise<BranchSlot>;
  advanceActiveLeaf(chatId: string, leafId: string): Promise<void>;
  switchSibling(
    chatId: string,
    messageId: string,
    targetIndex: number
  ): Promise<TreePathResult>;
  getSiblingCount(chatId: string, parentId: string | null): Promise<number>;
}
