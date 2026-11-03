// Hermes — grounding audit primitives for the search pipeline.
// The grounded-answer contract needs two signals the raw results
// don't carry: WHEN a source speaks from (publication date, only
// what the engine/page text actually states — never guessed) and
// HOW MUCH authority it carries (official > press > reference >
// blog > forum/social > unclassified web).

// ── Date extraction ──────────────────────────────────────────
// Only capture dates the source text itself states. A date without
// a year ("March 12") is deliberately ignored — it cannot be
// date-matched against a scope, so claiming it would be a guess.

const MONTHS =
  "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|" +
  "Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";

const RE_AGO = /\b\d{1,2}\s+(?:day|hour|week|month)s?\s+ago\b/i;
const RE_MDY = new RegExp(
  `\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+(?:19|20)\\d{2}\\b`,
  "i"
);
const RE_DMY = new RegExp(
  `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?,?\\s+(?:19|20)\\d{2}\\b`,
  "i"
);
const RE_MY = new RegExp(`\\b(?:${MONTHS})\\.?\\s+(?:19|20)\\d{2}\\b`, "i");

/**
 * First date the text states, or null. Priority: relative ("5 days
 * ago" — precise against retrieval time) > full date > month+year.
 * A bare year alone is too weak to match against a scope → skipped.
 */
export function extractDateHint(text: string): string | null {
  if (!text) return null;
  const ago = RE_AGO.exec(text);
  if (ago) return ago[0].toLowerCase();
  for (const re of [RE_MDY, RE_DMY, RE_MY]) {
    const m = re.exec(text);
    if (m) return m[0].replace(/\s+/g, " ").trim();
  }
  return null;
}

// ── Authority tiers ──────────────────────────────────────────
// Deterministic classification for the common cases; anything
// unknown stays "web" (aggregator-level on the ladder) instead of
// being flattered into a tier it didn't earn.

const FORUM_HOSTS = [
  "reddit.com",
  "quora.com",
  "stackoverflow.com",
  "news.ycombinator.com",
  "x.com",
  "twitter.com",
  "facebook.com",
  "tiktok.com",
  "youtube.com",
  "threads.net",
  "discord.com",
];

const OFFICIAL_HOSTS = [
  "blog.google",
  "googleblog.com",
  "deepmind.google",
  "gemini.google.com",
  "google.com",
  "anthropic.com",
  "openai.com",
  "ai.meta.com",
  "meta.ai",
  "apple.com",
  "microsoft.com",
  "nvidia.com",
  "deepseek.com",
  "moonshot.ai",
  "qwen.ai",
  "mistral.ai",
  "x.ai",
];

const PRESS_HOSTS = [
  "reuters.com",
  "bloomberg.com",
  "apnews.com",
  "bbc.com",
  "bbc.co.uk",
  "nytimes.com",
  "theverge.com",
  "techcrunch.com",
  "arstechnica.com",
  "wired.com",
  "cnbc.com",
  "venturebeat.com",
  "engadget.com",
  "zdnet.com",
  "tomshardware.com",
  "9to5google.com",
  "androidauthority.com",
  "theinformation.com",
  "futurism.com",
  "livescience.com",
  "space.com",
  "nature.com",
  "science.org",
];

const REFERENCE_HOSTS = ["wikipedia.org", "britannica.com"];

const BLOG_HOSTS = [
  "medium.com",
  "substack.com",
  "dev.to",
  "hashnode.dev",
  "wordpress.com",
  "ghost.io",
];

export type AuthorityTier =
  | "official"
  | "press/news"
  | "reference"
  | "blog"
  | "forum/social"
  | "web";

function hostMatches(host: string, list: string[]): boolean {
  return list.some((d) => host === d || host.endsWith("." + d));
}

/**
 * Authority tier for a result URL, per the grounded-answer ladder:
 * official > press/news > reference > blog > forum/social, with
 * "web" for anything unclassified.
 */
export function authorityTier(url: string): AuthorityTier {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "web";
  }
  if (hostMatches(host, OFFICIAL_HOSTS)) return "official";
  if (hostMatches(host, PRESS_HOSTS)) return "press/news";
  if (hostMatches(host, REFERENCE_HOSTS)) return "reference";
  if (hostMatches(host, BLOG_HOSTS)) return "blog";
  if (hostMatches(host, FORUM_HOSTS)) return "forum/social";
  return "web";
}

/** Bare hostname of a URL (fallback: the raw string). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// ── Confidence label (grounded-answer contract) ─────────────
// The contract requires EXACTLY ONE confidence label as the whole
// answer's final line. Parsing lives here so the pipeline (label
// enforcement) and the UI (badge rendering) share one definition.

export type ConfidenceLabel = "confirmed" | "partial" | "stale sources";

const LABEL_LINE_RE =
  /^(?:\*{0,2})(?:confidence(?:\s+label)?\s*:?\s*\*{0,2})?\[(confirmed|partial|stale sources)\](?:\*{0,2}|\.?)\s*$/i;

/** The label iff the line IS the label (optional legacy variants). */
export function labelOfLine(line: string): ConfidenceLabel | null {
  const m = LABEL_LINE_RE.exec((line ?? "").trim());
  return m ? (m[1].toLowerCase() as ConfidenceLabel) : null;
}

/** The label iff the content's final non-empty line IS the label. */
export function confidenceOf(content: string): ConfidenceLabel | null {
  if (!content?.trim()) return null;
  const last = content.trimEnd().split("\n").pop() ?? "";
  return labelOfLine(last);
}
