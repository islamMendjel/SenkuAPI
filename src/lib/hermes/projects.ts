// Hermes — projects (Run 37): chats that live in folders, folders
// that carry their own instructions. Server-side helpers shared by
// the API routes and the gateway. The prompt block itself lives in
// ./constants (pure, client-safe); this module owns persistence.

import { db } from "@/lib/db";
import {
  PROJECT_INSTRUCTIONS_MAX,
  PROJECT_LIMIT,
  PROJECT_NAME_MAX,
} from "./constants";

export interface ProjectRow {
  id: string;
  name: string;
  instructions: string;
  chatCount: number;
  createdAt: string;
  updatedAt: string;
}

/** List all projects with their live chat counts (createdAt asc —
 *  a stable sidebar order that never reorders after edits). */
export async function listProjects(): Promise<ProjectRow[]> {
  const rows = await db.project.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      instructions: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { chats: { where: { isTemporary: false } } } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    instructions: r.instructions,
    chatCount: r._count.chats,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export interface ProjectInput {
  name?: string;
  instructions?: string;
}

/** Field-by-field sanitize of user input (same contract as
 *  sanitizeRitualInput): trims, caps lengths, and reports errors
 *  the routes translate to honest 400s. */
export function sanitizeProjectInput(
  body: ProjectInput
): { ok: true; name: string; instructions: string } | { ok: false; error: string } {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { ok: false, error: "Project name is required." };
  if (name.length > PROJECT_NAME_MAX) {
    return {
      ok: false,
      error: `Name is too long (max ${PROJECT_NAME_MAX} characters).`,
    };
  }
  const instructions =
    typeof body.instructions === "string"
      ? body.instructions.trim().slice(0, PROJECT_INSTRUCTIONS_MAX)
      : "";
  return { ok: true, name, instructions };
}

/** Resolve the project context for a turn. `chatId` is server
 *  truth (the chat's own row decides); `draftProjectId` only
 *  applies to chats that don't exist yet (the client names the
 *  project it was created in — validated here, never trusted
 *  blindly). Returns null when no project applies; instructions
 *  may be empty (folder-only project → no prompt block). */
export async function projectForTurn(
  chatId: string | null | undefined,
  draftProjectId: string | null | undefined
): Promise<{ id: string; name: string; instructions: string } | null> {
  if (chatId) {
    const chat = await db.chat.findUnique({
      where: { id: chatId },
      select: {
        project: {
          select: { id: true, name: true, instructions: true },
        },
      },
    });
    return chat?.project ?? null;
  }
  if (draftProjectId) {
    const project = await db.project.findUnique({
      where: { id: draftProjectId },
      select: { id: true, name: true, instructions: true },
    });
    return project ?? null;
  }
  return null;
}

/** Honest capacity check for the create route. */
export async function projectCount(): Promise<number> {
  return db.project.count();
}

export { PROJECT_LIMIT, PROJECT_NAME_MAX, PROJECT_INSTRUCTIONS_MAX };
