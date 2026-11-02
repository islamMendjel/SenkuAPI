// SenkuAPI — gateway constants.
// NO LOCAL MODELS: every completion is executed in the cloud
// (active provider's OpenAI-compatible endpoint, with the Z.ai
// cloud runtime as automatic failover). Nothing runs locally.

import {
  authorityTier,
  hostOf,
} from "./grounding";
import type { SearchSource } from "./types";

// ── Token discipline ─────────────────────────────────────────
// Output constraints appended to every system message.
export const OUTPUT_CONSTRAINTS =
  "Be concise. No preamble. No Sure!. Answer directly. Skip restating the question.";

// ── Knowledge honesty (anti-hallucination) ───────────────────
// Without web-search results the model only knows its training
// data. Questions about "the latest X" must not invent version
// numbers, release dates or product names — the model admits the
// limit and points at the Search toggle instead.
export const KNOWLEDGE_HONESTY =
  "KNOWLEDGE HONESTY — your knowledge comes from training data with a cutoff. " +
  "When the user asks about the latest/newest/most recent releases, models, " +
  "versions, prices, news or anything time-sensitive, and NO web search " +
  "results are provided in this turn: do NOT invent specific version numbers, " +
  "release dates or product names. Name only what you are genuinely confident " +
  "about, state that newer releases may exist since your training data, and " +
  "suggest the user turn on web search (the globe button) for a grounded, " +
  "up-to-date answer.";

export const BASE_SYSTEM_PROMPT =
  "You are SenkuAPI, the user's personal AI gateway. You route to pooled cloud " +
  "provider keys with prompt caching and OpenAI compatibility. Answer helpfully " +
  "in clean Markdown when structure helps. " +
  KNOWLEDGE_HONESTY +
  " " +
  OUTPUT_CONSTRAINTS;

// Grounded-answer contract for search turns — the search results
// are inputs, not truth; the user's question is the contract. The
// model must extract the question's time scope / claim type /
// precision, audit every result (date match, authority, relevance),
// classify the retrieval honestly, and end with a confidence label.
export const SEARCH_SYSTEM_DIRECTIVE =
  "GROUNDED ANSWER CONTRACT — the web search results below are inputs, not truth; " +
  "the user's question is the contract. " +
  "(1) EXTRACT THE CONTRACT before writing: the TIME SCOPE (\"this month\" = the current " +
  "calendar month; \"latest\" = the most recent ever), the CLAIM TYPE (factual needs dated " +
  "sources; opinion/speculation is labeled as such; a negative claim — \"has X happened?\" — " +
  "is the hardest to prove), and the PRECISION required (names + dates + versions, not vibes). " +
  "(2) AUDIT each result: DATE MATCH (does its stated date fall inside the scope?), AUTHORITY " +
  "(official announcement > press/news > aggregator/unclassified web > blog > forum/social — " +
  "a forum or social post can NEVER support a factual claim, especially a negative one), " +
  "RELEVANCE (does it actually answer the question, or just share keywords?). Then classify " +
  "the retrieval honestly: FULL (dated in scope, authoritative, on-topic), PARTIAL (some " +
  "match, others older or off-topic), STALE (the best sources predate the scope — they can " +
  "describe the past but cannot confirm the present). " +
  "(3) WRITE THE ANSWER: state a date for every claim — an undated release is not an answer. " +
  "Never silently broaden or narrow the question: if the user asked for November and the " +
  "results only cover October, say so explicitly. For negative claims report the knowledge " +
  "boundary: \"As of my most recent source (date, site), the latest is X; a newer release " +
  "after that date cannot be ruled out.\" If the retrieval is PARTIAL or STALE, lead with " +
  "what matches the scope and clearly mark what does not. End the message with EXACTLY ONE " +
  "confidence label on the whole answer — on its own final line with nothing else on that " +
  "line: [confirmed], [partial], or [stale sources]. Never attach confidence labels to " +
  "individual sources or inside inline sentences. " +
  "NEVER: present older data under the requested time scope; use a source's publication date " +
  "as if it were a release date; let an old source support an \"as of today\" claim; cite " +
  "forums or social media for factual or negative claims; list items without dates when the " +
  "question is about releases; pad with off-topic results to look thorough. A partial, " +
  "honest answer beats a confident, off-target one. " +
  "Cite the source domains inline like [example.com], and never invent URLs. " +
  OUTPUT_CONSTRAINTS;

// ── Effort dial directives ───────────────────────────────────
// MEDIUM turns use the prompts above verbatim (zero behavior
// change). FAST and DEEP append their own block — which also
// naturally namespaces the response cache per effort level.

/** FAST: speed-first. Fewest words that fully answer. */
export const FAST_SYSTEM_ADDON =
  "FAST MODE — the user chose speed. Answer in the fewest words that " +
  "fully answer the question. Prefer a direct answer or a tight list; " +
  "no background, no caveats unless they change the answer, no " +
  "summaries of what you are about to say. If a longer explanation " +
  "exists, offer it in one short closing line instead of writing it.";

/** DEEP with retrieval: the grounded contract + a research report. */
export const DEEP_RESEARCH_ADDON =
  "DEEP RESEARCH MODE — multiple search rounds ran for this question. " +
  "Before writing, weigh ALL the evidence: where independent sources " +
  "AGREE (state it — agreement is evidence), where they CONFLICT " +
  "(name the sources on each side and which is more authoritative/" +
  "recent — never average a conflict away), and what remains " +
  "UNANSWERED even after every round (say so explicitly; do not pad). " +
  "Structure the answer: (1) the direct answer with dates, (2) the " +
  "evidence — what each relevant source contributes and how it was " +
  "cross-checked, (3) disagreements or gaps, briefly. Depth of rigor, " +
  "not length: every sentence must carry information. " +
  "All grounded-contract rules above still apply in full, including " +
  "the final confidence label.";

/** DEEP without retrieval: thinking mode on the strongest engine. */
export const DEEP_THINKING_ADDON =
  "THINKING MODE — the user asked for your deepest reasoning. Work " +
  "through the problem rigorously BEFORE writing: decompose it, " +
  "consider the approaches, pick the strongest one and stress-test " +
  "it against the edge cases. Do NOT show this scratch work — " +
  "present only the polished result, organized and complete. Depth " +
  "of rigor, not length.";

// ── One-shot response styles (Run 17 slash commands) ─────────
// Armed by /code and /concise in the composer, consumed by exactly
// ONE send, then cleared. Appended to the base system prompt (which
// also namespaces the 24h response cache per style — a /code answer
// and a plain answer to the same question cache separately).

/** /code — code-focused answer, no introductory chatter. */
export const CODE_STYLE_ADDON =
  "CODE MODE — the user asked for a code-focused answer. Lead with " +
  "the code. No introductory chatter, no summary outro, no " +
  "\"certainly!\" openers. Prose is allowed only where it is " +
  "genuinely needed: a one-line note between code blocks, a short " +
  "inline comment, or a brief explanation when the code alone would " +
  "be misleading. Assume the user can read code.";

/** /concise — ultra-brief answer. */
export const CONCISE_STYLE_ADDON =
  "CONCISE MODE — the user asked for an ultra-brief answer. Answer " +
  "in the fewest words that are still complete and correct: ideally " +
  "one to three sentences, or a single tight list. No preamble, no " +
  "filler, no restating the question, no recap of what was said.";

// ── Deep search pipeline ─────────────────────────────────────
export const DEEP_SEARCH_MAX_QUERIES = 4; // 1 primary + up to 3 planned
export const DEEP_SEARCH_MAX_SOURCES = 8; // merged, URL-deduped cap

// ── 3-tier pacing limiter (OxionAI) ──────────────────────────
// Tier 1 — Monthly Pool : 500,000 tokens / key / month
// Tier 2 — Daily Pace   : monthly pool spread over 30 usage days
//                         (usage day = 01:00 → 01:00, Africa/Algiers)
// Tier 3 — 5H Burst     : rolling 5-hour window at 2× average pace
export const MONTHLY_POOL_PER_KEY = 500_000;
export const DAILY_PACE_TARGET = Math.ceil(MONTHLY_POOL_PER_KEY / 30); // 16,667
export const BURST_5H_LIMIT = Math.round(DAILY_PACE_TARGET * (5 / 24) * 2); // 6,945
export const HIGH_PACE_THRESHOLD = 0.9; // ≥90% of daily target → "High Pace"

// ── Response cache ───────────────────────────────────────────
export const CACHE_TTL_HOURS = 24;

// ── Web search discipline (duckduckgo-search equivalent) ─────
export const SEARCH_MAX_RESULTS = 3;
export const SEARCH_SNIPPET_MAX_CHARS = 300;
export const SEARCH_TITLE_MAX_CHARS = 90;

// ── Providers ────────────────────────────────────────────────
export const OXIONAI_BASE_URL = "https://api.oxionai.dev/v1";
export const APINEX_BASE_URL = "https://api.apinex.bond/v1";
export const APINEX_TEST_KEY =
  "sk-apx6afb8d9b8f503c4ac6f3b81e1d0db670c22001ba2790baf";

export const OXIONAI_MODELS = [
  "claude-fable-5.1",
  "claude-opus-5.5",
  "claude-sonnet-5.5",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
];

// Default list = the Free-page roster, probe-verified servable on
// /v1/chat/completions 2026-11-03 (1-token probes, all 200).
// Deliberately NOT listed: free/jev-1.13 (apinex rejects it on the
// chat endpoint — "Jev Group Decision model" — permanently broken in
// a picker) and every paid-tier id (this gateway runs free keys; a
// 402 model is a broken model). The Sync endpoint keeps the same
// free-tier scope. Survives restarts — the seed never overwrites a
// synced/stored list.
export const APINEX_MODELS = [
  "free/glm-5.3",
  "free/glm-5.3-flash",
  "free/glm-5.3-flashx",
  "free/gemini-3.8-flash",
  "free/qwen-3.8-max",
  "free/kimi-k3",
  "free/deepseek-v4.1-flash",
  "free/deepseek-v4-pro-0813",
  "free/minimax-m3.1-flash",
  "free/gpt-6-luna",
  "free/muse-spark-1.3",
];

// Free-tier ids the provider advertises but that are NOT callable on
// /v1/chat/completions (probed 2026-11-03: apinex answers 400 "Jev
// Group Decision model and cannot be called on /v1/chat/completions").
// Sync strips these so the picker can never ingest a model that
// fails on every send.
export const APINEX_NON_CHAT_IDS = ["free/jev-1.13"];

// ── Identity (single-user personal gateway) ──────────────────
export const USER = {
  name: "senku",
  email: "gamerislam21@gmail.com",
  plan: "Ultimate plan (unlimited)",
};

/** Every NEW chat starts on this model — the user can switch freely. */
export const DEFAULT_MODEL = "free/glm-5.3";

// ── Live context ("now" is always grounded) ──────────────────
// Every system prompt carries the real current date/time so the
// model never has to guess what "today" means.
export const USER_TIMEZONE = "Africa/Algiers";
export const USER_TIMEZONE_LABEL = "Algiers";

const liveDateFmt = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: USER_TIMEZONE,
});

/** "Sunday 1 November 2026" in the user's timezone. */
export function liveDate(now: Date = new Date()): string {
  return liveDateFmt.format(now);
}

/** "18:41:07" (or "18:41") in the user's timezone. */
export function liveTime(
  withSeconds: boolean,
  now: Date = new Date()
): string {
  return new Intl.DateTimeFormat(
    "en-GB",
    withSeconds
      ? {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
          timeZone: USER_TIMEZONE,
        }
      : {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: USER_TIMEZONE,
        }
  ).format(now);
}

/** Ground-truth clock injected into every system prompt. */
export function liveContextBlock(now: Date = new Date()): string {
  return (
    "LIVE CONTEXT — the actual current date and time right now is " +
    `${liveDate(now)}, ${liveTime(true, now)} (${USER_TIMEZONE}). ` +
    "Treat this as absolute ground truth for any question about today, " +
    "now, dates, deadlines or schedules. Never claim you lack real-time " +
    "date information, and never contradict this clock."
  );
}

/**
 * Hour-stable variant used ONLY in cache keys: identical within the
 * same clock hour so repeat questions still hit the response cache,
 * while the prompt the model sees keeps second-level precision.
 *
 * NOTE: must stay HOUR-granular — an earlier version formatted the
 * time with liveTime(false) ("18:41"), silently embedding the MINUTE
 * and making the 24h cache hit only within the same minute.
 */
export function liveContextBlockHourStable(now: Date = new Date()): string {
  const hour = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hour12: false,
    timeZone: USER_TIMEZONE,
  }).format(now);
  return (
    "LIVE CONTEXT — the actual current date and time right now is " +
    `${liveDate(now)}, hour ${hour}:00 (${USER_TIMEZONE}).`
  );
}

export function searchContextBlock(
  sources: SearchSource[],
  now: Date = new Date()
): string {
  if (!sources.length) return "";
  const lines = sources.map((s, i) => {
    const tier = authorityTier(s.url);
    const date = s.dateHint ? `dated: ${s.dateHint}` : "dated: none stated";
    return (
      `[${i + 1}] ${s.title}\n` +
      `    ${hostOf(s.url)} (${tier}) · ${date}\n` +
      `    URL: ${s.url}\n` +
      `    ${s.snippet}`
    );
  });
  return (
    `\n\n--- WEB SEARCH RESULTS — inputs, not truth; the user's question is the contract ---\n` +
    `Retrieved ${liveDate(now)}, ${liveTime(false, now)} (${USER_TIMEZONE}). ` +
    `Each result's date is its publication date as stated by the engine or page text — ` +
    `it is NEVER a release date. "dated: none stated" means the source gave no date; ` +
    `treat it as undated, do not guess one.\n` +
    lines.join("\n")
  );
}
