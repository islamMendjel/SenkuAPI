// POST /api/search — capped web search (≤3 results, ≤300 chars/snippet)
import { NextRequest, NextResponse } from "next/server";
import { webSearch } from "@/lib/senku/search";
import { ensureSeed } from "@/lib/senku/seed";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  await ensureSeed();
  const body = await req.json().catch(() => ({}));
  const query = (body.query ?? "").toString().trim();
  if (!query) {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }
  const results = await webSearch(query);
  return NextResponse.json({ query, count: results.length, results });
}
