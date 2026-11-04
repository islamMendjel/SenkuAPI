// POST /api/keys/[id]/probe — Run 42: run ONE liveness probe NOW.
// Self-service healing: after the owner completes a daily check-in
// (402) or replaces a rejected key, the seat flips the moment the
// fix actually landed — no waiting for the background prober's next
// tick or the breaker's cooldown expiry.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { probeKeyNow } from "@/lib/hermes/pool";
import { providerView } from "@/lib/hermes/serialize";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await probeKeyNow(id);

  if (result.reason === "not-found") {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }
  if (result.reason === "inactive") {
    return NextResponse.json(
      { error: "Key is toggled off — activate it first." },
      { status: 409 }
    );
  }

  // Return the refreshed provider view so the client's store updates
  // from the same truth the prober just wrote.
  const key = await db.apiKey.findUnique({
    where: { id },
    include: { provider: true },
  });
  const view = key ? await providerView(key.provider) : null;

  return NextResponse.json({ ...result, view });
}
