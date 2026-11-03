// GET /v1/models — THE EXOCORE (Run 40): the OpenAI-spec model list
// external CLIs probe first. Serves the ACTIVE provider's LIVE model
// roster (what the Sync button maintains) with the two canonical
// free ids guaranteed present, so a client that hardcodes
// "free/glm-5.3" or "free/gemini-3.8-flash" always resolves.

import {
  bridgeAuthorized,
  bridgeCorsHeaders,
  bridgeError,
  bridgePreflight,
} from "@/lib/hermes/bridge";
import { getActiveProvider } from "@/lib/hermes/router";
import { ensureSeed } from "@/lib/hermes/seed";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// The two ids external tooling may hardcode (spec contract).
const GUARANTEED_MODELS = ["free/glm-5.3", "free/gemini-3.8-flash"];

export async function OPTIONS() {
  return bridgePreflight();
}

export async function GET(req: NextRequest) {
  if (!bridgeAuthorized(req)) {
    return bridgeError(401, "Invalid or missing bridge token.", "authentication_error");
  }
  await ensureSeed();
  const provider = await getActiveProvider();
  const live: string[] = JSON.parse(provider.models || "[]");
  const data = [
    ...GUARANTEED_MODELS.filter((id) => !live.includes(id)),
    ...live,
  ].map((id) => ({
    id,
    object: "model",
    owned_by: provider.slug,
  }));

  return Response.json(
    { object: "list", data },
    {
      headers: {
        ...bridgeCorsHeaders(),
        "X-Hermes-Provider": provider.name,
      },
    }
  );
}
