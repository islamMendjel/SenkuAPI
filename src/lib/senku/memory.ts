// SenkuAPI — persistent personal memory: SERVER-ONLY reader (Run 28).
//
// This module touches the database and must never be imported from a
// client component (that would drag Prisma into the browser — the
// exact crash this split prevents). The pure, client-safe pieces
// (limits, types, sanitize, prompt formatting) live in ./constants.
//
// The gateway calls getMemories() once per turn and appends the
// formatted block to the base system prompt — which is also the
// response-cache key material, so editing memory naturally
// invalidates stale cached answers, and an empty memory leaves the
// prompt byte-identical to pre-memory turns (old cache still hits).

import { db } from "@/lib/db";
import type { MemoryEntry } from "./constants";
import { MEMORY_MAX_ENTRIES } from "./constants";

/** All memory entries, oldest first (stable order = stable prompt).
 *  Never throws — a failed read is "no memory". */
export async function getMemories(): Promise<MemoryEntry[]> {
  try {
    return await db.memory.findMany({
      orderBy: { createdAt: "asc" },
      take: MEMORY_MAX_ENTRIES,
      select: { id: true, content: true },
    });
  } catch {
    return [];
  }
}
