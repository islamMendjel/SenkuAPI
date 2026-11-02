// GET /api/usage — limiter snapshot for the ACTIVE provider
// (3-tier breakdown: Monthly Pool, Daily Pace, 5H Burst)
import { NextResponse } from "next/server";
import { ensureSeed } from "@/lib/senku/seed";
import { usageSnapshot } from "@/lib/senku/serialize";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeed();
  const snapshot = await usageSnapshot();
  return NextResponse.json(snapshot);
}
