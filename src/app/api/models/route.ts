// GET /api/models           — models of the ACTIVE provider
// GET /api/models?sync=1    — re-sync from the provider's /v1/models
//                              (OpenAI-compatible), DB list as fallback
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { APINEX_NON_CHAT_IDS } from "@/lib/hermes/constants";
import { getActiveProvider } from "@/lib/hermes/router";
import { ensureSeed } from "@/lib/hermes/seed";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  await ensureSeed();
  const provider = await getActiveProvider();
  const sync = req.nextUrl.searchParams.get("sync") === "1";

  let models: string[] = JSON.parse(provider.models || "[]");
  let synced = false;

  if (sync && provider.baseUrl) {
    try {
      const key = await db.apiKey.findFirst({
        where: { providerId: provider.id, isActive: true },
        orderBy: { createdAt: "asc" },
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${provider.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${key?.keyValue ?? ""}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const json = (await res.json()) as { data?: { id?: string }[] };
        const remote = (json.data ?? [])
          .map((m) => m.id)
          .filter((id): id is string => typeof id === "string");
        if (remote.length) {
          // Free-key scope: when the provider exposes a free/* tier,
          // sync ONLY those ids. Everything else is either paid (a
          // 402 at runtime on this gateway's free keys) or — like
          // jev-1.13 — not callable on /v1/chat/completions at all.
          // Ingesting them would fill the picker with broken models.
          const free = remote.filter(
            (id) =>
              id.startsWith("free/") && !APINEX_NON_CHAT_IDS.includes(id)
          );
          models = (free.length ? free : remote).sort();
          synced = true;
          await db.provider.update({
            where: { id: provider.id },
            data: { models: JSON.stringify(models) },
          });
        }
      }
    } catch {
      // keep DB list on sync failure
    }
  }

  return NextResponse.json({
    provider: {
      name: provider.name,
      slug: provider.slug,
      baseUrl: provider.baseUrl,
    },
    models,
    synced,
  });
}
