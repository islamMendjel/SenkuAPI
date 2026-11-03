// PATCH /api/keys/[id] — enable/disable a pooled key
// DELETE /api/keys/[id] — remove a pooled key
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { providerView } from "@/lib/hermes/serialize";

export const dynamic = "force-dynamic";

async function keyProvider(id: string) {
  const key = await db.apiKey.findUnique({
    where: { id },
    include: { provider: true },
  });
  return key?.provider ?? null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const provider = await keyProvider(id);
  if (!provider) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }
  await db.apiKey.update({
    where: { id },
    data: { isActive: body.isActive !== false },
  });
  return NextResponse.json(await providerView(provider));
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const provider = await keyProvider(id);
  if (!provider) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }
  await db.apiKey.delete({ where: { id } });
  return NextResponse.json(await providerView(provider));
}
