// POST /api/providers/[id]/keys — add a pooled key to a provider
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ensureSeed } from "@/lib/hermes/seed";
import { providerView } from "@/lib/hermes/serialize";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureSeed();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const keyValue = (body.key ?? "").toString().trim();
  if (!keyValue || keyValue.length < 8) {
    return NextResponse.json(
      { error: "A valid API key is required (min 8 chars)" },
      { status: 400 }
    );
  }
  const provider = await db.provider.findUnique({ where: { id } });
  if (!provider) {
    return NextResponse.json({ error: "Provider not found" }, { status: 404 });
  }
  const count = await db.apiKey.count({ where: { providerId: id } });
  await db.apiKey.create({
    data: {
      providerId: id,
      label:
        (body.label ?? "").toString().trim().slice(0, 40) ||
        `Pool key #${count + 1}`,
      keyValue,
      monthKey: `${new Date().getFullYear()}-${String(
        new Date().getMonth() + 1
      ).padStart(2, "0")}`,
    },
  });
  return NextResponse.json(await providerView(provider));
}
