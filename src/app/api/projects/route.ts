// GET  /api/projects — list projects with live chat counts
// POST /api/projects — create a project {name, instructions?}
// Run 37 — THE PROJECTS. The sidebar section, the move submenu and
// the ⌘K palette all read this list; instructions are injected into
// every turn of every chat in the project by the gateway.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ensureSeed } from "@/lib/hermes/seed";
import {
  listProjects,
  projectCount,
  sanitizeProjectInput,
  PROJECT_LIMIT,
} from "@/lib/hermes/projects";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeed();
  return NextResponse.json({ projects: await listProjects() });
}

export async function POST(req: NextRequest) {
  await ensureSeed();
  const body = await req.json().catch(() => ({}));
  const clean = sanitizeProjectInput(body);
  if (!clean.ok) {
    return NextResponse.json({ error: clean.error }, { status: 400 });
  }
  if ((await projectCount()) >= PROJECT_LIMIT) {
    return NextResponse.json(
      { error: `Project limit reached (${PROJECT_LIMIT}).` },
      { status: 409 }
    );
  }
  const project = await db.project.create({
    data: { name: clean.name, instructions: clean.instructions },
  });
  return NextResponse.json({
    project: {
      id: project.id,
      name: project.name,
      instructions: project.instructions,
      chatCount: 0,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    },
  });
}
