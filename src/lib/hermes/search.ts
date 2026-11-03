// Hermes — web search with strict token discipline.
// Strategy (cloud-only, regex/string parsing — no local models):
//   1. DuckDuckGo HTML endpoint  (duckduckgo-search equivalent)
//   2. DuckDuckGo Lite endpoint  (different rate-limit bucket)
//   3. Z.ai cloud web_search     (up to 2 attempts, fully cloud)
// Plus a 30-minute in-memory memo so edit/regenerate turns and
// rapid repeats never re-hit the network.
// Discipline on ALL paths: max 3 results, 300 chars per snippet,
// HTML tags stripped to prevent token bloating.

import ZAI from "z-ai-web-dev-sdk";
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
  "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
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

/** Primary: DuckDuckGo HTML search (lightweight regex parsing). */
async function duckDuckGoHtmlSearch(query: string): Promise<SearchSource[]> {
  const res = await fetchWithTimeout("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UAS[Date.now() % UAS.length],
      "Accept-Language": "en-US,en;q=0.9",
    },
    body: `q=${encodeURIComponent(query)}&kl=wt-wt`,
  }, 6000);
  if (!res || !res.ok) return [];
  const html = await res.text().catch(() => "");
  if (!html || /anomaly|challenge|captcha/i.test(html.slice(0, 4000))) return [];

  const results: SearchSource[] = [];
  const blockRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>(?=[\s\S]{0,4000}?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>)/g;
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

/** Secondary: DuckDuckGo Lite (separate endpoint, separate rate bucket). */
async function duckDuckGoLiteSearch(query: string): Promise<SearchSource[]> {
  const res = await fetchWithTimeout("https://lite.duckduckgo.com/lite/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UAS[(Date.now() + 1) % UAS.length],
      "Accept-Language": "en-US,en;q=0.9",
    },
    body: `q=${encodeURIComponent(query)}&kl=wt-wt`,
  }, 6000);
  if (!res || !res.ok) return [];
  const html = await res.text().catch(() => "");
  if (!html || /anomaly|challenge|captcha/i.test(html.slice(0, 4000))) return [];

  // Lite page: rows of <a class="result-link" href="…">title</a> …
  // followed by a <td class="result-snippet">…</td>
  const results: SearchSource[] = [];
  const linkRe =
    /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,3000}?<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>)?/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    if (results.length >= SEARCH_MAX_RESULTS) break;
    const url = unwrapDdgHref(m[1]);
    if (!isHttpUrl(url)) continue;
    const title = clampTitle(m[2]);
    const snippet = clampSnippet(m[4] ?? "");
    results.push({
      title,
      url,
      snippet,
      dateHint: extractDateHint(`${title} ${snippet}`) ?? undefined,
    });
  }
  return results;
}

/** Tertiary: Z.ai cloud web_search (server-side only, retried). */
async function zaiCloudSearchOnce(query: string): Promise<SearchSource[]> {
  try {
    const zai = await ZAI.create();
    const items = await zai.functions.invoke("web_search", {
      query,
      num: SEARCH_MAX_RESULTS,
    });
    if (!Array.isArray(items)) return [];
    return items
      .slice(0, SEARCH_MAX_RESULTS)
      .map((it: {
        name?: string;
        url?: string;
        snippet?: string;
        date?: string;
      }) => {
        const title = clampTitle(it.name ?? "");
        const snippet = clampSnippet(it.snippet ?? "");
        // Prefer the engine's own date field; fall back to the first
        // date the title/snippet text states. Both are publication
        // signals, never release dates.
        const engineDate = typeof it.date === "string" ? it.date.trim() : "";
        return {
          title,
          url: it.url ?? "",
          snippet,
          dateHint:
            engineDate ||
            extractDateHint(`${title} ${snippet}`) ||
            undefined,
        };
      })
      .filter((r) => isHttpUrl(r.url));
  } catch {
    return [];
  }
}

async function zaiCloudSearch(query: string): Promise<SearchSource[]> {
  // Two attempts with a short backoff — the cloud path is the
  // last line of defense, so it must absorb transient failures.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 450));
    const results = await zaiCloudSearchOnce(query);
    if (results.length > 0) return results;
  }
  return [];
}

/** Resolve with the FIRST non-empty result list; [] once all settle empty. */
function firstNonEmpty(promises: Promise<SearchSource[]>[]): Promise<SearchSource[]> {
  return new Promise((resolve) => {
    let pending = promises.length;
    let done = false;
    for (const p of promises) {
      p.then((r) => {
        if (!done && r.length > 0) {
          done = true;
          resolve(r);
        }
      })
        .catch(() => {})
        .finally(() => {
          pending -= 1;
          if (pending === 0 && !done) {
            done = true;
            resolve([]);
          }
        });
    }
  });
}

// ── 30-minute in-memory memo ─────────────────────────────────
const memo = new Map<string, { at: number; results: SearchSource[] }>();
const MEMO_TTL_MS = 30 * 60 * 1000;
const MEMO_MAX = 64;

export interface WebSearchOutcome {
  results: SearchSource[];
  source: "ddg-html" | "ddg-lite" | "zai-cloud" | "memo" | "none";
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

  // Layered failover: both DDG endpoints race in parallel (first
  // non-empty wins), then the Z.ai cloud as a retried last resort.
  let results = await firstNonEmpty([
    duckDuckGoHtmlSearch(q),
    duckDuckGoLiteSearch(q),
  ]);
  let source: WebSearchOutcome["source"] = "ddg-html";
  if (results.length === 0) {
    results = await zaiCloudSearch(q);
    source = results.length ? "zai-cloud" : "none";
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
