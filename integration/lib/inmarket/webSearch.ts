/**
 * RecruitersOS · In-Market · paid web search — the decision-maker NAMING backend
 *
 * The NAMING bottleneck runs on free search-engine SCRAPING (DuckDuckGo / Bing / Mojeek /
 * SearXNG). That hop is rate-limited on every source IP, and from this box it is not merely
 * degraded but ARCHITECTURALLY DEAD — every one of the five free engines reports okRate 0 /
 * throttleRate 1, so the single biggest naming strategy (reading "Jane Doe - VP of Engineering -
 * Acme" straight out of public result titles) resolves nobody. Companies pile up at status
 * `sourced` (owning TITLE known, no NAME), never earn an email, and therefore never become
 * renderable video supply. This module is the paid replacement for that hop.
 *
 * THREE INTERCHANGEABLE PROVIDERS, best-value first. Whichever is configured wins; all of them are
 * Google-backed SERP APIs, so they honor `site:linkedin.com/in` X-ray operators and return clean
 * JSON — exactly what the LinkedIn-title parsers in decisionMaker.ts / xray.ts already consume:
 *
 *   1. SERPER       — SERPER_API_KEY. ~$0.001/query, 10 results. MEASURED FIRST CHOICE: on a live
 *                     6-company sample of the real stuck backlog it returned right-company
 *                     LinkedIn titles for 4 of 6 ("Todd Smith - Senior Director of Operations -
 *                     gusto!", "Henry Cong - Senior Director of Finance at Chime").
 *   2. DATAFORSEO   — DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD. The failover, NOT the default: on
 *                     that same sample the live/regular endpoint returned nothing at all for 2 of
 *                     5 `site:` queries and no right-company hits, while billing $0.01–0.02 per
 *                     task — 10–20x Serper for worse naming. It earns its place only as the
 *                     engine that keeps naming alive if Serper credits run dry.
 *   3. RAPIDAPI     — RAPID_WEBSEARCH_KEY (real-time-web-search). Kept for continuity; last
 *                     because it is the most expensive subscription of the three.
 *
 * Set INMARKET_SEARCH_PROVIDER to pin one explicitly ("dataforseo" | "serper" | "rapidapi" |
 * "off"); otherwise the order above picks the first one whose credentials exist. "off" disables
 * the paid hop entirely and returns the callers to the free rotation.
 *
 * SPEND IS CAPPED, NOT TRUSTED TO CALLER DISCIPLINE. Naming re-attempts every unnamed company on
 * a ~90-minute cycle and the callers' in-process caches are wiped by every deploy, so an
 * uncapped paid hop would re-buy the same misses all day. Two guards, both here:
 *   - a PERSISTENT daily query budget (INMARKET_SEARCH_DAILY_MAX, default 2,000/day) that
 *     survives container restarts, so worst-case spend is bounded and knowable; and
 *   - `webSearchReady()`, which the callers check so an exhausted budget falls THROUGH to the
 *     free rotation instead of silently naming nobody.
 * At the default cap of 2,000 the ceiling is about $2/day on Serper. Note that the same cap on
 * DataForSEO would be ~$20–40/day, so LOWER INMARKET_SEARCH_DAILY_MAX before failing over to it.
 *
 * Cost note for whoever tunes this: a paid query only ever runs on a company the free strategies
 * (team page, news, GitHub, Common Crawl) already failed to name, so it bills on misses only —
 * the same cheapest-first policy as paidEmail/paidNaming.
 */

import { noteRapidQuota } from "../sourcing/rapidQuota";
import { loadSnapshot, saveSnapshot } from "../db";

const TIMEOUT_MS = 12_000;

export type WebSearchProvider = "dataforseo" | "serper" | "rapidapi";

/** The provider that will serve queries, or null when none is configured / the hop is pinned off. */
export function webSearchProvider(): WebSearchProvider | null {
  const pin = (process.env.INMARKET_SEARCH_PROVIDER || "").trim().toLowerCase();
  if (pin === "off" || pin === "0" || pin === "none") return null;
  if (pin === "dataforseo") return dataforseoConfigured() ? "dataforseo" : null;
  if (pin === "serper") return serperConfigured() ? "serper" : null;
  if (pin === "rapidapi") return rapidConfigured() ? "rapidapi" : null;
  // Best value first — see the header note for the measured comparison behind this order.
  if (serperConfigured()) return "serper";
  if (dataforseoConfigured()) return "dataforseo";
  if (rapidConfigured()) return "rapidapi";
  return null;
}

function dataforseoConfigured(): boolean {
  return !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}
function serperConfigured(): boolean {
  return !!process.env.SERPER_API_KEY;
}
function rapidConfigured(): boolean {
  return !!process.env.RAPID_WEBSEARCH_KEY;
}

/** True once ANY paid search provider is configured. Says nothing about remaining budget — use
 *  `webSearchReady()` before choosing this backend over the free rotation. */
export function webSearchEnabled(): boolean {
  return webSearchProvider() !== null;
}

/* ------------------------------------------------------------------ */
/* Daily spend ceiling (persistent)                                    */
/* ------------------------------------------------------------------ */

const BUDGET_KEY = "inmarket_websearch_budget_v1";
const SAVE_DEBOUNCE_MS = 10_000;

interface BudgetState {
  /** UTC day this counter belongs to, YYYY-MM-DD. */
  day: string;
  /** Paid queries billed today. */
  used: number;
  /** Which provider spent them (informational; the meter is per-day, not per-provider). */
  provider?: string;
}

let budget: BudgetState | null = null;
let hydrating: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Hard ceiling on paid queries per UTC day. 0 disables the paid hop outright. */
export function dailyQueryCap(): number {
  const n = Number(process.env.INMARKET_SEARCH_DAILY_MAX);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2_000;
}

async function hydrateBudget(): Promise<void> {
  if (budget) return;
  hydrating ??= (async () => {
    const saved = await loadSnapshot<BudgetState>(BUDGET_KEY).catch(() => null);
    budget = saved && typeof saved.used === "number" && typeof saved.day === "string"
      ? saved
      : { day: today(), used: 0 };
  })();
  await hydrating;
  hydrating = null;
}

/** Persist the counter at most once per SAVE_DEBOUNCE_MS — the ceiling only has to survive a
 *  restart, and a write per query would be pure churn at 2,000/day. */
function scheduleBudgetSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (budget) void saveSnapshot(BUDGET_KEY, budget).catch(() => {});
  }, SAVE_DEBOUNCE_MS);
  // Never hold the process open for a counter flush.
  (saveTimer as unknown as { unref?: () => void }).unref?.();
}

/** Today's paid-query spend against the ceiling. Surfaced for the engine-health readout. */
export async function webSearchBudget(): Promise<{ used: number; cap: number; provider: string | null }> {
  await hydrateBudget();
  if (budget && budget.day !== today()) budget = { day: today(), used: 0 };
  return { used: budget?.used ?? 0, cap: dailyQueryCap(), provider: webSearchProvider() };
}

/** Reserve one paid query. False when the ceiling is reached (caller must fall back to free). */
async function spendOne(provider: WebSearchProvider): Promise<boolean> {
  await hydrateBudget();
  const day = today();
  if (!budget || budget.day !== day) budget = { day, used: 0 };
  if (budget.used >= dailyQueryCap()) return false;
  budget.used++;
  budget.provider = provider;
  scheduleBudgetSave();
  return true;
}

/**
 * True when a paid provider is configured AND today's budget still has room. Callers check this
 * (not `webSearchEnabled`) so an exhausted ceiling degrades to the free engine rotation rather
 * than to silence.
 */
export async function webSearchReady(): Promise<boolean> {
  if (!webSearchEnabled()) return false;
  const b = await webSearchBudget();
  return b.used < b.cap;
}

/* ------------------------------------------------------------------ */
/* Results                                                            */
/* ------------------------------------------------------------------ */

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

/** DataForSEO live "regular" Google SERP: one synchronous task, up to `depth` organic results.
 *  Same endpoint the JD Sourcing wide-web pass uses, so one balance funds both. */
async function dataforseoSearch(query: string): Promise<WebResult[]> {
  const auth = Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString("base64");
  const depth = Math.max(10, Math.min(Number(process.env.INMARKET_SEARCH_DEPTH) || 50, 100));
  const res = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/regular", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify([{ keyword: query, location_code: 2840, language_code: "en", depth }]),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null) as {
    tasks?: Array<{ result?: Array<{ items?: unknown[] }> }>;
  } | null;
  const items = data?.tasks?.[0]?.result?.[0]?.items;
  return Array.isArray(items) ? parseResults(items) : [];
}

/** Serper (serper.dev) — Google results as JSON, 1 credit per query. */
async function serperSearch(query: string): Promise<WebResult[]> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": process.env.SERPER_API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: 10 }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null) as { organic?: unknown[] } | null;
  return Array.isArray(data?.organic) ? parseResults(data.organic) : [];
}

const rapidCfg = {
  host: () => process.env.RAPID_WEBSEARCH_HOST || "real-time-web-search.p.rapidapi.com",
  path: () => process.env.RAPID_WEBSEARCH_PATH || "/search",
  queryParam: () => process.env.RAPID_WEBSEARCH_QUERY_PARAM || "q",
  limitParam: () => (process.env.RAPID_WEBSEARCH_LIMIT_PARAM ?? "limit"),
  limit: () => process.env.RAPID_WEBSEARCH_LIMIT || "20",
  gl: () => (process.env.RAPID_WEBSEARCH_GL ?? "us"),
  hl: () => (process.env.RAPID_WEBSEARCH_HL ?? "en"),
};

/** RapidAPI real-time-web-search (the original provider). */
async function rapidSearch(query: string): Promise<WebResult[]> {
  const host = rapidCfg.host();
  const u = new URL(`https://${host}${rapidCfg.path()}`);
  u.searchParams.set(rapidCfg.queryParam(), query);
  if (rapidCfg.limitParam()) u.searchParams.set(rapidCfg.limitParam(), rapidCfg.limit());
  if (rapidCfg.gl()) u.searchParams.set("gl", rapidCfg.gl());
  if (rapidCfg.hl()) u.searchParams.set("hl", rapidCfg.hl());
  const res = await fetch(u.toString(), {
    method: "GET",
    headers: {
      "X-RapidAPI-Key": process.env.RAPID_WEBSEARCH_KEY!,
      "X-RapidAPI-Host": host,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // Feed the credit meter so the Owner Console's spend dashboard can tell a working
  // subscription from one nobody wired up.
  noteRapidQuota(host, res.headers, "search");
  if (!res.ok) return [];
  const data: unknown = await res.json().catch(() => null);
  return data ? parseResults(data) : [];
}

/**
 * Run ONE query through the configured paid search provider and return its results. [] on any
 * miss/error/timeout, when unconfigured, or when today's budget is spent. Authenticated paid API →
 * default route, no egress rotation (rotation is only for the free scrapers this replaces).
 */
export async function webSearchResults(query: string): Promise<WebResult[]> {
  const provider = webSearchProvider();
  if (!provider || !query) return [];
  if (!(await spendOne(provider))) return [];   // ceiling reached — caller falls back to free
  try {
    if (provider === "dataforseo") return await dataforseoSearch(query);
    if (provider === "serper") return await serperSearch(query);
    return await rapidSearch(query);
  } catch {
    return [];
  }
}

/** Convenience: just the result titles (the "Name - Title - Company" strings the naming parsers eat). */
export async function webSearchTitles(query: string): Promise<string[]> {
  return (await webSearchResults(query)).map((r) => r.title).filter(Boolean);
}
