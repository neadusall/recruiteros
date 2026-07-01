/**
 * RecruitersOS · In-Market · Real-Time Web Search (RapidAPI) — the decision-maker search backend
 *
 * The NAMING bottleneck used to run on free search-engine SCRAPING (DuckDuckGo / Bing / Mojeek /
 * SearXNG). That hop is rate-limited on every source IP — the documented reason the naming fleet
 * ran red. This module replaces it with a single reliable paid search:
 *
 *     https://rapidapi.com/letscrape-6bRBa3QguO5/api/real-time-web-search
 *
 * It's a Google-backed SERP API, so it honors `site:linkedin.com/in` X-ray operators and returns
 * clean JSON ({title, url, description}) — exactly what the existing LinkedIn-title parsers in
 * decisionMaker.ts / xray.ts consume. One authenticated call per query, no per-IP throttle, no
 * egress rotation needed.
 *
 * ENV-GATED (same pattern as paidNaming/paidEmail): returns [] (a no-op) unless RAPID_WEBSEARCH_KEY
 * is set. When it IS set, it becomes the SOLE search backend and the free scrapers are bypassed —
 * i.e. "JSearch + real-time-web-search only". Without the key the callers fall back to the free
 * engine rotation, so local/dev without a key still works.
 *
 *   RAPID_WEBSEARCH_KEY          (required) your RapidAPI X-RapidAPI-Key — enables the provider
 *   RAPID_WEBSEARCH_HOST         default "real-time-web-search.p.rapidapi.com"
 *   RAPID_WEBSEARCH_PATH         default "/search"
 *   RAPID_WEBSEARCH_QUERY_PARAM  default "q"        (the param that carries the search string)
 *   RAPID_WEBSEARCH_LIMIT_PARAM  default "limit"    (set "" to omit)
 *   RAPID_WEBSEARCH_LIMIT        default "20"
 *   RAPID_WEBSEARCH_GL           default "us"       (region; set "" to omit)
 *   RAPID_WEBSEARCH_HL           default "en"       (language; set "" to omit)
 */

const TIMEOUT_MS = 9_000;

/** True once the real-time web search provider is configured. */
export function webSearchEnabled(): boolean {
  return !!process.env.RAPID_WEBSEARCH_KEY;
}

const cfg = {
  host: () => process.env.RAPID_WEBSEARCH_HOST || "real-time-web-search.p.rapidapi.com",
  path: () => process.env.RAPID_WEBSEARCH_PATH || "/search",
  queryParam: () => process.env.RAPID_WEBSEARCH_QUERY_PARAM || "q",
  limitParam: () => (process.env.RAPID_WEBSEARCH_LIMIT_PARAM ?? "limit"),
  limit: () => process.env.RAPID_WEBSEARCH_LIMIT || "20",
  gl: () => (process.env.RAPID_WEBSEARCH_GL ?? "us"),
  hl: () => (process.env.RAPID_WEBSEARCH_HL ?? "en"),
};

export interface WebResult {
  /** Result title, e.g. "Jane Doe - VP of Engineering - Acme | LinkedIn". */
  title: string;
  /** Canonical result URL (the linkedin.com/in/… profile link when it's a profile). */
  url: string;
  /** Result snippet/description. */
  snippet: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Tolerant across SERP-API response shapes: {data:[…]} (real-time-web-search), {results:[…]}, or a
 *  bare array. Each row may name its fields differently, so we probe the common aliases. */
function parseResults(data: unknown): WebResult[] {
  const root = data as { data?: unknown; results?: unknown } | unknown[] | null;
  const arr: unknown[] = Array.isArray(root) ? root
    : Array.isArray((root as { data?: unknown })?.data) ? (root as { data: unknown[] }).data
    : Array.isArray((root as { results?: unknown })?.results) ? (root as { results: unknown[] }).results
    : [];
  const out: WebResult[] = [];
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const title = str(o.title) || str(o.name) || str(o.heading);
    const url = str(o.url) || str(o.link) || str(o.href);
    const snippet = str(o.description) || str(o.snippet) || str(o.desc) || str(o.content) || str(o.body);
    if (title || url) out.push({ title, url, snippet });
  }
  return out;
}

/**
 * Run ONE query through the real-time web search API and return its results. [] on any
 * miss/error/timeout, or when not configured. Authenticated paid API → default route, no egress
 * rotation (rotation is only for the free scrapers this replaces).
 */
export async function webSearchResults(query: string): Promise<WebResult[]> {
  if (!webSearchEnabled() || !query) return [];
  const host = cfg.host();
  const u = new URL(`https://${host}${cfg.path()}`);
  u.searchParams.set(cfg.queryParam(), query);
  if (cfg.limitParam()) u.searchParams.set(cfg.limitParam(), cfg.limit());
  if (cfg.gl()) u.searchParams.set("gl", cfg.gl());
  if (cfg.hl()) u.searchParams.set("hl", cfg.hl());
  try {
    const res = await fetch(u.toString(), {
      method: "GET",
      headers: {
        "X-RapidAPI-Key": process.env.RAPID_WEBSEARCH_KEY!,
        "X-RapidAPI-Host": host,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data: unknown = await res.json().catch(() => null);
    return data ? parseResults(data) : [];
  } catch {
    return [];
  }
}

/** Convenience: just the result titles (the "Name - Title - Company" strings the naming parsers eat). */
export async function webSearchTitles(query: string): Promise<string[]> {
  return (await webSearchResults(query)).map((r) => r.title).filter(Boolean);
}
