// POST /api/rituals/[id]/run — fire a ritual NOW, out of schedule.
// The same engine path the scheduler uses (in-flight guarded, so a
// tick and a manual click can never double-run one ritual), then
// the schedule advances from this run — exactly like an automatic
// fire. Bills the pool honestly, like any typed turn.
import { NextRequest, NextResponse } from "next/server";
import { ensureSeed } from "@/lib/hermes/seed";
import { runRitual } from "@/lib/hermes/ritual";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureSeed();
  const { id } = await params;
  try {
    const outcome = await runRitual(id);
    return NextResponse.json(outcome);
  } catch (e) {
    const err = e as Error & { code?: string };
    const status =
      err.code === "busy" ? 409 : err.code === "not-found" ? 404 : 500;
    return NextResponse.json(
      { error: err.message, code: err.code ?? "error" },
      { status }
    );
  }
}
