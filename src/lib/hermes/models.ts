// Hermes — model display metadata.
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
  // Run 24 — roster expansion (visible on the provider's Free page,
  // probe-verified servable 2026-11-03). free/jev-1.13 is NOT listed:
  // apinex rejects it on /v1/chat/completions ("Jev Group Decision
  // model"), so a picker entry would be permanently broken.
  "free/deepseek-v4-pro-0813": { name: "DeepSeek V4 Pro", tier: "Free", note: "Deep reasoning" },
  "free/gpt-6-luna": { name: "GPT 6 Luna", tier: "Free", note: "Balanced" },
  "free/minimax-m3.1-flash": { name: "MiniMax M3.1 Flash", tier: "Free", note: "Fast" },
  "free/muse-spark-1.3": { name: "Muse Spark 1.3", tier: "Free", note: "Creative" },
  // OxionAI
  "claude-fable-5.1": { name: "Claude Fable 5.1", tier: "Pool", note: "Balanced" },
  "claude-opus-5.5": { name: "Claude Opus 5.5", tier: "Pool", note: "Most capable" },
  "claude-sonnet-5.5": { name: "Claude Sonnet 5.5", tier: "Pool", note: "Balanced" },
  "deepseek-v4-flash": { name: "DeepSeek V4 Flash", tier: "Pool", note: "Fast" },
  "deepseek-v4-pro": { name: "DeepSeek V4 Pro", tier: "Pool", note: "Deep reasoning" },
  // Run 22 — Image Forge pseudo-model: never listed in the provider
  // pickers (it is not a pool model); only the timeline provenance,
  // exports and history rows ever render its name.
  "image-forge": { name: "Image Forge", tier: null, note: "Text → image" },
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

// ── Family glyphs (picker roster identity) ───────────────────

export interface ModelGlyph {
  /** 1–3 letter family monogram shown in a tinted chip */
  tag: string;
  /** Tailwind text/bg classes for the tinted chip (no blue/indigo) */
  cls: string;
}

const FAMILY_GLYPH: Record<string, ModelGlyph> = {
  glm: { tag: "GLM", cls: "text-emerald-300 bg-emerald-500/10" },
  gemini: { tag: "GEM", cls: "text-amber-300 bg-amber-500/10" },
  qwen: { tag: "QW", cls: "text-violet-300 bg-violet-500/10" },
  kimi: { tag: "KI", cls: "text-rose-300 bg-rose-500/10" },
  deepseek: { tag: "DS", cls: "text-teal-300 bg-teal-500/10" },
  minimax: { tag: "MM", cls: "text-orange-300 bg-orange-500/10" },
  gpt: { tag: "GPT", cls: "text-lime-300 bg-lime-500/10" },
  muse: { tag: "MU", cls: "text-fuchsia-300 bg-fuchsia-500/10" },
  claude: { tag: "CL", cls: "text-yellow-300 bg-yellow-500/10" },
};

const GLYPH_FALLBACK: ModelGlyph = {
  tag: "·",
  cls: "text-zinc-400 bg-zinc-500/10",
};

/** Vendor chip for a model id — the roster's at-a-glance identity.
 *  Declared before modelFamily; function declarations hoist, so the
 *  call below resolves fine at runtime. */
export function modelGlyph(id: string): ModelGlyph {
  return FAMILY_GLYPH[modelFamily(id)] ?? GLYPH_FALLBACK;
}

// ── Duel support ─────────────────────────────────────────────

/** Model family key for contrast pairing: "free/glm-5.3" → "glm",
 *  "claude-opus-5.5" → "claude". Known vendor stems win; otherwise
 *  the leading letter-run of the id is the family. */
export function modelFamily(id: string): string {
  const raw = id.startsWith("free/") ? id.slice(5) : id;
  const known = raw.match(
    /^(gemini|glm|qwen|kimi|deepseek|claude|gpt|grok|llama|mistral|minimax|muse)/i
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
