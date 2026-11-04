// POST /api/usage/rehearse — THE RING REHEARSAL (Run 43).
// Dry-runs the active provider's round-robin N turns into the
// future using the real pick logic (breaker, pacing tiers, drift
// repair) WITHOUT touching the live cursor: the rehearsal runs
// under the pick lock and the pre-run cursor state is restored
// before the response leaves the gateway. The body carries the
// fairness proof and the per-seat skip reasons.
import { NextResponse } from "next/server";
import { ensureSeed } from "@/lib/hermes/seed";
import { getActiveProvider, rehearseRing } from "@/lib/hermes/router";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    await ensureSeed();
    let turns = 10;
    try {
      const body = (await req.json()) as { turns?: number };
      if (body && typeof body.turns === "number" && Number.isFinite(body.turns)) {
        turns = body.turns;
      }
    } catch {
      // empty body → default 10 turns
    }
    const provider = await getActiveProvider();
    const result = await rehearseRing(provider.id, turns);
    return NextResponse.json({
      providerName: provider.name,
      ...result,
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message || "Rehearsal failed" },
      { status: 500 }
    );
  }
}
