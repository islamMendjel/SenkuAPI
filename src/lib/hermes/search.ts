// Senku — web search with strict token discipline.
// Strategy (cloud-only, regex/string parsing — zero local compute):
//   1. DuckDuckGo HTML endpoint  (with modern browser spoofing)
//   2. DuckDuckGo HTML mirror    (alternate endpoint)
//   3. Wikipedia Knowledge API   (reliable public factual fallback)
// Plus a 30-minute in-memory memo so edit/regenerate turns and
// rapid repeats never re-hit the network.
// Discipline on ALL paths: max 3 results, 300 chars per snippet,
// HTML tags stripped to prevent token bloating.

import {
  DEEP_SEARCH_MAX_QUERIES,
  DEEP_SEARCH_MAX_SOURCES,
  SEARCH_MAX_RESULTS,
  SEARCH_SNIPPET_MAX_CHARS,
  SEARCH_TITLE_MAX_CHARS,
} from "./constants";
import { planSearchQueries } from "./executor";
import { extractDateHint } from "./grounding";
import type { SearchSource } from "./types";

const UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
];

/** Strip HTML tags and decode the common entities (regex only). */
export function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

/** Hard-cap a snippet at N characters on a word boundary. */
export function clampSnippet(text: string, max = SEARCH_SNIPPET_MAX_CHARS): string {
  const clean = stripHtml(text).replace(/\s*Read more\.?\s*$/i, "");
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

function clampTitle(text: string): string {
  const clean = stripHtml(text);
  return clean.length > SEARCH_TITLE_MAX_CHARS
    ? clean.slice(0, SEARCH_TITLE_MAX_CHARS - 1).trimEnd() + "…"
    : clean;
}

/** Extract the real URL from a DuckDuckGo redirect href. */
function unwrapDdgHref(href: string): string {
  try {
    const h = href.startsWith("//") ? "https:" + href : href;
    const hEsc = h.replace(/&amp;/g, "&");
    const url = new URL(hEsc);
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : hEsc;
  } catch {
    return href;
  }
}

function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms: number
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Primary: DuckDuckGo HTML search with realistic browser headers. */
async function duckDuckGoHtmlSearch(query: string): Promise<SearchSource[]> {
  const ua = UAS[Math.floor(Math.random() * UAS.length)];
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        "User-Agent": ua,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://duckduckgo.com/",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Ch-Ua":
          '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Linux"',
      },
    },
    6000
  );
  if (!res || !res.ok) return [];
  const html = await res.text().catch(() => "");
  if (!html || /anomaly|challenge|captcha/i.test(html.slice(0, 4000))) return [];

  const results: SearchSource[] = [];
  const blockRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    if (results.length >= SEARCH_MAX_RESULTS) break;
    const url = unwrapDdgHref(m[1]);
    if (!isHttpUrl(url)) continue;
    const title = clampTitle(m[2]);
    const snippet = clampSnippet(m[3] ?? "");
    results.push({
      title,
      url,
      snippet,
      dateHint: extractDateHint(`${title} ${snippet}`) ?? undefined,
    });
  }
  return results;
}

/** Secondary: DuckDuckGo HTML mirror. */
async function duckDuckGoLiteSearch(query: string): Promise<SearchSource[]> {
  const ua = UAS[Math.floor(Math.random() * UAS.length)];
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        "User-Agent": ua,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://duckduckgo.com/",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
      },
    },
    6000
  );
  if (!res || !res.ok) return [];
  const html = await res.text().catch(() => "");
  if (!html || /anomaly|challenge|captcha/i.test(html.slice(0, 4000))) return [];

  const results: SearchSource[] = [];
  const blockRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    if (results.length >= SEARCH_MAX_RESULTS) break;
    const url = unwrapDdgHref(m[1]);
    if (!isHttpUrl(url)) continue;
    const title = clampTitle(m[2]);
    const snippet = clampSnippet(m[3] ?? "");
    results.push({
      title,
      url,
      snippet,
      dateHint: extractDateHint(`${title} ${snippet}`) ?? undefined,
    });
  }
  return results;
}

/** Tertiary: Wikipedia Knowledge API (reliable public factual fallback). */
async function wikipediaSearch(query: string): Promise<SearchSource[]> {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      query
    )}&utf8=&format=json`;
    const res = await fetchWithTimeout(
      url,
      {
        headers: {
          "User-Agent": UAS[0],
          Accept: "application/json",
        },
      },
      5000
    );
    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => null);
    const items = data?.query?.search;
    if (!Array.isArray(items)) return [];

    const results: SearchSource[] = [];
    for (const it of items) {
      if (results.length >= SEARCH_MAX_RESULTS) break;
      const title = clampTitle(it.title ?? "");
      const snippet = clampSnippet(it.snippet ?? "");
      const dateHint =
        typeof it.timestamp === "string"
          ? it.timestamp.slice(0, 10)
          : extractDateHint(`${title} ${snippet}`) ?? undefined;
      results.push({
        title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(
          (it.title ?? "").replace(/ /g, "_")
        )}`,
        snippet,
        dateHint,
      });
    }
    return results;
  } catch {
    return [];
  }
}

// ── 30-minute in-memory memo ─────────────────────────────────
const memo = new Map<string, { at: number; results: SearchSource[] }>();
const MEMO_TTL_MS = 30 * 60 * 1000;
const MEMO_MAX = 64;

export interface WebSearchOutcome {
  results: SearchSource[];
  source: "ddg-html" | "ddg-lite" | "wikipedia" | "memo" | "none";
}

/** Web search with capped results and layered failover. */
export async function webSearchDetailed(
  query: string
): Promise<WebSearchOutcome> {
  const q = query.trim().slice(0, 400);
  if (!q) return { results: [], source: "none" };

  const key = q.toLowerCase();
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) {
    return { results: hit.results, source: "memo" };
  }

  // Layered failover: Primary DDG HTML -> Secondary DDG HTML mirror -> Tertiary Wikipedia API
  let results = await duckDuckGoHtmlSearch(q);
  let source: WebSearchOutcome["source"] = "ddg-html";

  if (results.length === 0) {
    results = await duckDuckGoLiteSearch(q);
    source = results.length ? "ddg-lite" : "none";
  }

  if (results.length === 0) {
    results = await wikipediaSearch(q);
    source = results.length ? "wikipedia" : "none";
  }

  if (results.length) {
    if (memo.size >= MEMO_MAX) {
      // drop the oldest entry
      const firstKey = memo.keys().next().value;
      if (firstKey !== undefined) memo.delete(firstKey);
    }
    memo.set(key, { at: Date.now(), results });
  }

  return { results: results.slice(0, SEARCH_MAX_RESULTS), source };
}

/** Back-compat entry point — the only search API other modules need. */
export async function webSearch(query: string): Promise<SearchSource[]> {
  return (await webSearchDetailed(query)).results;
}

// ── Deep search — multi-round iterative retrieval ────────────
// The medium-effort search runs ONE query and stops. Deep effort
// instead: plan extra queries around the question (cheap cloud
// pass), run them all (round 1 first, then the planned variants in
// parallel), merge URL-deduped, and cap at DEEP_SEARCH_MAX_SOURCES.
// Every query reuses webSearchDetailed's layered failover + memo,
// so repeated deep turns never re-hit the network within 30 min.

export interface DeepSearchOutcome {
  results: SearchSource[];
  /** every query that actually ran, in order (primary first) */
  queries: string[];
  /** round 1's engine — "none" when even the primary query failed */
  source: WebSearchOutcome["source"];
}

/** Normalize a URL for dedupe: strip protocol, www, trailing slash,
 *  and common tracking params — same page = same key. */
function dedupeKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    return `${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

export async function deepSearchDetailed(
  question: string,
  onStage?: (label: string) => void
): Promise<DeepSearchOutcome> {
  const primary = question.trim().slice(0, 400);
  if (!primary) return { results: [], queries: [], source: "none" };

  // ── Round 0: plan — what else should we search for? ──
  onStage?.("Deep research — planning queries");
  const planned = await planSearchQueries(primary);

  // ── Round 1: the question itself (verbatim, as the user asked) ──
  onStage?.(`Searching — “${truncate(primary, 46)}”`);
  const first = await webSearchDetailed(primary);
  const merged: SearchSource[] = [...first.results];
  const seen = new Set<string>(merged.map((s) => dedupeKey(s.url)));
  const queries = [primary];

  // ── Rounds 2+: the planned variants, in parallel ──
  const extra = planned
    .filter((q) => q.toLowerCase() !== primary.toLowerCase())
    .slice(0, DEEP_SEARCH_MAX_QUERIES - 1);
  if (extra.length) {
    onStage?.(
      `Searching ${extra.length} more angle${extra.length === 1 ? "" : "s"} — ${extra
        .map((q) => `“${truncate(q, 24)}”`)
        .join(", ")}`
    );
    queries.push(...extra);
    const rounds = await Promise.all(extra.map((q) => webSearchDetailed(q)));
    for (const outcome of rounds) {
      for (const s of outcome.results) {
        const key = dedupeKey(s.url);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(s);
        if (merged.length >= DEEP_SEARCH_MAX_SOURCES) break;
      }
      if (merged.length >= DEEP_SEARCH_MAX_SOURCES) break;
    }
  }

  return {
    results: merged.slice(0, DEEP_SEARCH_MAX_SOURCES),
    queries,
    source: first.source,
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
