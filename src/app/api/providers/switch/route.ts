// POST /api/providers/switch — switching rule:
// exactly ONE provider active; the selected becomes active and all
// others are set to false. Round-robin then runs on its keys only.
import { NextRequest, NextResponse } from "next/server";
import { switchProvider } from "@/lib/senku/router";
import { ensureSeed } from "@/lib/senku/seed";
import { usageSnapshot } from "@/lib/senku/serialize";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  await ensureSeed();
  const body = await req.json().catch(() => ({}));
  const providerId = body.providerId as string | undefined;
  if (!providerId) {
    return NextResponse.json({ error: "providerId is required" }, { status: 400 });
  }
  try {
    await switchProvider(providerId);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 404 });
  }
  const snapshot = await usageSnapshot();
  return NextResponse.json(snapshot);
}
