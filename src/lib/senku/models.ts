// SenkuAPI — model display metadata.
// Turns raw provider ids ("free/glm-5.3") into human chip/picker
// labels: pretty name + tier + a short strength note. Unknown ids
// (e.g. freshly synced from the provider) fall back to a tidy
// prettification so nothing ever leaks an env-looking string.

import type { EffortLevel } from "./types";

export interface ModelMeta {
  /** "GLM 5.3" — never the raw id */
  name: string;
  /** "Free" | "Pool" | null — shown as a small badge */
  tier: string | null;
  /** "Fast" — picker hint (tier · note) */
  note: string | null;
}

const KNOWN: Record<string, ModelMeta> = {
  // APInex (free-tier ids verified servable 2026-11-02)
  "free/glm-5.3": { name: "GLM 5.3", tier: "Free", note: "Balanced" },
  "free/gemini-3.8-flash": { name: "Gemini 3.8 Flash", tier: "Free", note: "Fastest" },
  "free/qwen-3.8-max": { name: "Qwen 3.8 Max", tier: "Free", note: "Deep reasoning" },
  "free/kimi-k3": { name: "Kimi K3", tier: "Free", note: "Long context" },
  "free/deepseek-v4.1-flash": { name: "DeepSeek 4.1 Flash", tier: "Free", note: "Fast" },
  "free/glm-5.3-flashx": { name: "GLM 5.3 FlashX", tier: "Free", note: "Fast" },
  "free/glm-5.3-flash": { name: "GLM 5.3 Flash", tier: "Free", note: "Fast" },
  "free/kimi-k2.8": { name: "Kimi K2.8", tier: "Free", note: null },
  // OxionAI
  "claude-fable-5.1": { name: "Claude Fable 5.1", tier: "Pool", note: "Balanced" },
  "claude-opus-5.5": { name: "Claude Opus 5.5", tier: "Pool", note: "Most capable" },
  "claude-sonnet-5.5": { name: "Claude Sonnet 5.5", tier: "Pool", note: "Balanced" },
  "deepseek-v4-flash": { name: "DeepSeek V4 Flash", tier: "Pool", note: "Fast" },
  "deepseek-v4-pro": { name: "DeepSeek V4 Pro", tier: "Pool", note: "Deep reasoning" },
};

/** Capitalize one token, keeping version numbers ("5.3") intact. */
function prettyToken(t: string): string {
  if (/^\d/.test(t)) return t; // 5.3, 4.1 …
  if (t.length <= 3 && t === t.toLowerCase()) return t.toUpperCase(); // glm, k3 …
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** "free/glm-5.3" → GLM 5.3 · Free · Balanced (best effort). */
export function modelMeta(id: string): ModelMeta {
  const known = KNOWN[id];
  if (known) return known;

  const free = id.startsWith("free/");
  const raw = free ? id.slice(5) : id;
  const name = raw
    .split("-")
    .filter(Boolean)
    .map(prettyToken)
    .join(" ")
    .trim();
  return {
    name: name || id,
    tier: free ? "Free" : null,
    note: null,
  };
}

/** Picker hint: "Free · Balanced" / "Free" / "" */
export function modelHint(meta: ModelMeta): string {
  return [meta.tier, meta.note].filter(Boolean).join(" · ");
}

// ── Duel support ─────────────────────────────────────────────

/** Model family key for contrast pairing: "free/glm-5.3" → "glm",
 *  "claude-opus-5.5" → "claude". Known vendor stems win; otherwise
 *  the leading letter-run of the id is the family. */
export function modelFamily(id: string): string {
  const raw = id.startsWith("free/") ? id.slice(5) : id;
  const known = raw.match(
    /^(gemini|glm|qwen|kimi|deepseek|claude|gpt|grok|llama|mistral)/i
  );
  if (known) return known[1].toLowerCase();
  const letters = raw.match(/^[a-z]+/i);
  return (letters?.[0] ?? raw).toLowerCase();
}

/** Default duel opponent: the first model from a DIFFERENT family
 *  (a real contrast — GLM vs Kimi, not GLM vs GLM), else the first
 *  different model. Null when there is nothing to duel against. */
export function autoChallenger(models: string[], primary: string): string | null {
  if (models.length < 2) return null;
  if (!models.includes(primary)) return models[0];
  const fam = modelFamily(primary);
  const others = models.filter((m) => m !== primary);
  return others.find((m) => modelFamily(m) !== fam) ?? others[0];
}

// ── Effort dial routing ───────────────────────────────────────

/**
 * Which engine serves an effort level — the pooled-routing core of
 * the dial. On a single-brand chat the "fast/quality" toggle just
 * flips one backend's reasoning switch; here the gateway picks the
 * right ENGINE from the pool:
 *   fast   → the fastest model on the active provider
 *   medium → the user's selected model (byte-identical behavior)
 *   deep   → the strongest model on the active provider
 * Falls back to the selection whenever the pool has no better fit,
 * so the dial can never route to a model the provider lacks.
 */
export function effortModel(
  models: string[],
  selected: string,
  effort: EffortLevel
): string {
  if (effort === "medium" || models.length === 0) return selected;

  const meta = (id: string) => KNOWN[id] ?? modelMeta(id);
  const nameOf = (id: string) => meta(id).name.toLowerCase();
  const noteOf = (id: string) => (meta(id).note ?? "").toLowerCase();

  // Routing pool for the dial: the free/* tier when the provider has
  // one — on metered providers those are the ids this account can
  // actually serve (pool-tier ids can require top-ups/subscriptions
  // and fail with 402 at runtime). Providers without a free tier
  // (OxionAI) route over their full list as before.
  const dialPool = models.some((m) => m.startsWith("free/"))
    ? models.filter((m) => m.startsWith("free/"))
    : models;

  if (effort === "fast") {
    // Prefer the curated "Fastest", then "Fast", then any
    // flash/mini/swift-style name in the pool.
    const fastest = dialPool.find((m) => noteOf(m).includes("fastest"));
    const fast = dialPool.find((m) => noteOf(m).includes("fast"));
    const named = dialPool.find((m) =>
      /flash|mini|swift|turbo|instant|lite/.test(nameOf(m))
    );
    return fastest ?? fast ?? named ?? selected;
  }

  // deep: strongest reasoning engine available.
  const capable = dialPool.find((m) => noteOf(m).includes("most capable"));
  const deep = dialPool.find((m) => noteOf(m).includes("deep reasoning"));
  const proNamed = dialPool.find((m) =>
    /(opus|max|pro|ultra|r1|thinking)/.test(nameOf(m))
  );
  return capable ?? deep ?? proNamed ?? selected;
}
