/**
 * RecruitersOS · JD Sourcing
 * Discovery orchestrator — turn the JD-derived queries into a ranked candidate list.
 *
 * This is the part that "goes out and finds the people." It hands each Boolean /
 * keyword query to a configured engine and accumulates results, deduped and scored,
 * until it hits the cap or runs out of queries.
 *
 * Engines (cheapest-first, matching the project's cost discipline):
 *   - google: Google Programmable Search (Custom Search JSON API) over the X-ray
 *       Boolean we already generate. 100 queries/day FREE, so it runs first as a free
 *       pass. Configure GOOGLE_CSE_KEY + GOOGLE_CSE_CX. Lower/variable quality than a
 *       paid listing (and respect Google's ToS) — it's a free first pass, not a
 *       replacement for rapidapi.
 *   - searx: the self-hosted SearXNG meta-search container (the same one the In-Market
 *       engine uses) running the X-ray Boolean. FREE and always-on when the container is
 *       up (SOURCING_SEARXNG_URL or INMARKET_SEARXNG_URL), so JD Sourcing always has a
 *       working engine even with zero paid keys configured.
 *   - rapidapi: a marketplace LinkedIn/people-search listing (the chosen scale path).
 *       Configure RAPIDAPI_KEY + RAPIDAPI_PEOPLE_SEARCH_HOST/PATH to point at whatever
 *       listing you subscribe to. Listings differ, so the result mapping is defensive,
 *       and a 404 on the configured path self-heals by probing the listing's common
 *       people-search path variants once per process.
 *   - scraper: the Playwright sidecar (li_at cookie), best-effort people-search.
 *
 * If no engine is configured the run returns an empty list plus an explicit warning —
 * it never fabricates candidates.
 *
 * NEVER-EMPTY SAFEGUARD: when engines DO find people but the strict-location drop or
 * the fit bar would discard every one of them, rescueEmptyRun() brings the best of
 * them back, marked (`outOfArea`) and explained in a warning, instead of returning a
 * zero-row result for a run that actually found profiles.
 */

import type { CandidateICP, CandidateRow, DiscoveryOptions, SourcingQuery } from "./types";
import { scoreCandidate, inTargetGeo } from "./score";
import { scraperConfigured, scrapeSearchViaSidecar } from "../linkedin/scraperProvider";
import { cred } from "../providers/http";

/* ------------------------------------------------------------------ */
/* RapidAPI people-search provider (configurable)                      */
/* ------------------------------------------------------------------ */

// All resolve workspace-first at call time (per-workspace creds, then env), so a
// workspace can point JD Sourcing at its own RapidAPI listing in Setup.
const RAPIDAPI_KEY = () => cred("RAPIDAPI_KEY");
const PS_HOST = () => cred("RAPIDAPI_PEOPLE_SEARCH_HOST");
const PS_PATH = () => cred("RAPIDAPI_PEOPLE_SEARCH_PATH") || "/search/people"; // GET: {query},{page} interpolated
// "GET" (query-param listings) or "POST" (JSON-body listings, e.g. {keywords,count}).
const PS_METHOD = () => (cred("RAPIDAPI_PEOPLE_SEARCH_METHOD") || "GET").trim().toUpperCase();

// Profiles requested per page. Listings commonly hardcode a low limit (e.g. limit=10);
// we force it up so one request returns far more rows — same request cost, ~5x the data
// per call and ~5x more throughput against the plan's per-minute rate limit. Override with
// RAPIDAPI_PEOPLE_SEARCH_LIMIT; capped at 100 (most listings reject more).
const PAGE_LIMIT = () => {
  const n = parseInt(cred("RAPIDAPI_PEOPLE_SEARCH_LIMIT") || "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 50;
};

/** One people-search call's inputs. Structured fields feed dedicated filter params. */
interface SearchParams {
  name: string;
  page: number;
  limit: number;
  currentCompany?: string;
  geoLocation?: string;
  pastCompany?: string;
  /** Company headcount band (e.g. "201-500"), for Sales-Navigator-style listings that
   *  filter by employee count — the cheap way to keep a bulk pull inside a size band
   *  without an over-pull-and-discard pass. Maps to `company_headcount`. */
  headcount?: string;
}

/** A trimmed numeric LinkedIn id, or undefined — structured filters are id-based, not names. */
function numericId(v?: string): string | undefined {
  return v && /^\d+$/.test(v.trim()) ? v.trim() : undefined;
}

/** Append `key=value` only when it has a value, the template didn't token it, and the path lacks it. */
function appendParam(path: string, key: string, value: string | undefined, rawTemplate: string): string {
  if (!value) return path;
  if (rawTemplate.includes("{" + key + "}")) return path; // the template already placed it
  if (new RegExp("[?&]" + key + "=").test(path)) return path; // already present literally
  return path + (path.includes("?") ? "&" : "?") + key + "=" + encodeURIComponent(value);
}

export function rapidApiSearchConfigured(): boolean {
  return Boolean(RAPIDAPI_KEY() && PS_HOST());
}

/**
 * Live one-shot health check for the Connected → JD Sourcing "Test connection".
 * Fires a tiny search and reports whether the listing actually answered — so the
 * button turns green on success and surfaces the real error (bad path / key /
 * captcha) instead of a confusing "no client" message.
 */
export async function verifySourcingSearch(): Promise<{ ok: boolean; error?: string; found?: number }> {
  if (!RAPIDAPI_KEY()) return { ok: false, error: "Add your RapidAPI key first." };
  if (!PS_HOST()) return { ok: false, error: "Add the search host first." };
  try {
    const rows = await rapidApiPeopleSearch({ name: "recruiter", page: 1, limit: 3 });
    return { ok: true, found: rows.length };
  } catch (e: any) {
    return { ok: false, error: (e && e.message) || "search request failed" };
  }
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s || undefined;
}

/** Defensive extraction: marketplace listings vary wildly in field names. */
function mapRow(o: any): CandidateRow | null {
  if (!o || typeof o !== "object") return null;
  const fullName = str(o.fullName) || str(o.full_name) || str(o.name) ||
    [str(o.firstName) || str(o.first_name), str(o.lastName) || str(o.last_name)].filter(Boolean).join(" ").trim();
  if (!fullName) return null;
  // Some listings carry the role line in primarySubtitle ("CEO at Acme") and the
  // location in secondarySubtitle; derive company from an "X at Y" primary.
  const primary = str(o.primarySubtitle);
  let company = str(o.company) || str(o.company_name) || str(o.companyName) || str(o.current_company);
  if (!company && primary && / at /i.test(primary)) company = primary.split(/ at /i).slice(1).join(" at ").trim();
  // Many listings embed the employer in the title line ("Software Engineer @ Google | …"
  // or "VP Sales at Acme"); pull the company out so the target-company signal still scores.
  if (!company) {
    const t = str(o.title) || str(o.job_title) || str(o.headline);
    const m = t && t.match(/\s(?:@|at)\s+(.+)$/i);
    if (m) company = m[1].split(/[|·•·–—\-]| - /)[0].trim() || undefined;
  }
  let url = str(o.linkedin_url) || str(o.linkedinUrl) || str(o.profile_url) || str(o.profileUrl) ||
    str(o.url) || str(o.link) || str(o.profileURL) || str(o.navigationUrl);
  if (url) url = url.split("?")[0]; // strip tracking params → clean URL + reliable dedupe
  const pic = typeof o.profilePicture === "string" ? str(o.profilePicture) : str(o.profilePicture && o.profilePicture.profilePictureLink);
  return {
    fullName,
    title: str(o.title) || str(o.job_title) || str(o.jobTitle) || str(o.position) || (primary && primary !== "--" ? primary : undefined),
    headline: str(o.headline) || str(o.summary),
    company,
    location: str(o.location) || str(o.geo) || str(o.city) || str(o.region) || str(o.secondarySubtitle),
    linkedinUrl: url,
    imageUrl: str(o.image) || str(o.photo) || str(o.profile_image) || str(o.imageUrl) || pic,
    fitScore: 0,
    fitReasons: [],
    provider: "rapidapi",
  };
}

/** Pull the array of results out of whatever envelope the listing returns. */
function extractList(data: any): any[] {
  if (Array.isArray(data)) return data;
  for (const k of ["data", "results", "profiles", "people", "items", "hits", "response"]) {
    if (Array.isArray(data?.[k])) return data[k];
  }
  if (Array.isArray(data?.data?.items)) return data.data.items;
  return [];
}

/**
 * One people-search call. Two transports, same result shape:
 *  - GET listings: name/page/limit + structured filters go in the URL. A path that
 *    tokens {query}/{page}/{limit}/{current_company}/{geocode_location}/{past_company}
 *    is a full template; otherwise we interpolate what we can and APPEND the rest, so
 *    even an existing saved path (name/page only) still gets the precise filters.
 *  - POST listings: a JSON body { keywords, count, current_company, geocode_location }.
 */
// Common people-search path shapes across marketplace listings. When the configured
// path 404s (listings rename endpoints; a saved Setup value goes stale), we probe these
// ONCE against the SAME configured host and remember the first that answers, so the
// search self-heals instead of silently returning nothing forever.
const PS_PATH_VARIANTS = [
  "/api/v1/search/people", "/search/people", "/people/search", "/search-people", "/api/search/people",
];
let healedPath: { host: string; path: string } | null = null;

/** The effective GET path: the healed one for this host when a 404 was repaired. */
function effectivePsPath(host: string): string {
  if (healedPath && healedPath.host === host) return healedPath.path;
  return PS_PATH();
}

export async function rapidApiPeopleSearch(p: SearchParams): Promise<CandidateRow[]> {
  const host = PS_HOST();
  const headers: Record<string, string> = {
    "X-RapidAPI-Key": RAPIDAPI_KEY(), "X-RapidAPI-Host": host,
    Accept: "application/json", "Content-Type": "application/json",
  };

  let res: Response;
  if (PS_METHOD() === "POST") {
    // Body-based listing: the path is literal (no interpolation); search rides in the body.
    const url = `https://${host}${PS_PATH()}`;
    const bodyObj: Record<string, unknown> = { keywords: p.name, count: p.limit };
    if (p.currentCompany) bodyObj.current_company = p.currentCompany;
    if (p.geoLocation) bodyObj.geocode_location = p.geoLocation;
    if (p.pastCompany) bodyObj.past_company = p.pastCompany;
    if (p.headcount) bodyObj.company_headcount = p.headcount;
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(bodyObj) });
  } else {
    const buildPath = (rawBase: string): string => {
      const templated = rawBase.includes("{query}") || rawBase.includes("{page}");
      let path = rawBase
        .replace(/\{query\}/g, encodeURIComponent(p.name))
        .replace(/\{page\}/g, String(p.page))
        .replace(/\{limit\}/g, String(p.limit))
        .replace(/\{current_company\}/g, encodeURIComponent(p.currentCompany || ""))
        .replace(/\{geocode_location\}/g, encodeURIComponent(p.geoLocation || ""))
        .replace(/\{past_company\}/g, encodeURIComponent(p.pastCompany || ""))
        .replace(/\{company_headcount\}/g, encodeURIComponent(p.headcount || ""));
      if (!templated) {
        const sep = path.includes("?") ? "&" : "?";
        path = `${path}${sep}query=${encodeURIComponent(p.name)}&page=${p.page}`;
      }
      // Force the page size up (listings hardcode it low): rewrite an existing limit= or append one.
      path = /[?&]limit=\d+/i.test(path)
        ? path.replace(/limit=\d+/i, `limit=${p.limit}`)
        : `${path}${path.includes("?") ? "&" : "?"}limit=${p.limit}`;
      // Append the precise filters when the template didn't carry them itself.
      path = appendParam(path, "current_company", p.currentCompany, rawBase);
      path = appendParam(path, "geocode_location", p.geoLocation, rawBase);
      path = appendParam(path, "past_company", p.pastCompany, rawBase);
      path = appendParam(path, "company_headcount", p.headcount, rawBase);
      return path;
    };

    const raw = effectivePsPath(host);
    res = await fetch(`https://${host}${buildPath(raw)}`, { headers });

    // SELF-HEAL: a 404 on the configured path usually means the listing renamed its
    // endpoint (or Setup carries a stale path). Probe the common variants ONCE on the
    // same host; remember the first that answers so every later call goes straight there.
    if (res.status === 404 && !(healedPath && healedPath.host === host)) {
      for (const variant of PS_PATH_VARIANTS) {
        if (variant === raw.split("?")[0]) continue;
        const tryRes = await fetch(`https://${host}${buildPath(variant)}`, { headers }).catch(() => null);
        if (tryRes && tryRes.status !== 404) {
          healedPath = { host, path: variant };
          res = tryRes;
          break;
        }
      }
      if (!(healedPath && healedPath.host === host)) {
        throw new Error(
          `rapidapi ${host} 404 (no people-search endpoint answered on this listing; tried the configured path and ${PS_PATH_VARIANTS.join(", ")}. ` +
          `Fix RAPIDAPI_PEOPLE_SEARCH_HOST/PATH in Setup, or subscribe to a listing with a people search)`
        );
      }
    }
  }
  if (!res.ok) throw new Error(`rapidapi ${host} ${res.status}`);
  const data = await res.json().catch(() => ({}));
  // Surface an explicit API-level failure (e.g. captcha) instead of silently returning [].
  if (data && data.success === false && data.error) throw new Error(`rapidapi ${host}: ${String(data.error)}`);
  return extractList(data).map(mapRow).filter((r): r is CandidateRow => Boolean(r));
}

/* ------------------------------------------------------------------ */
/* Google Programmable Search provider (free first pass)               */
/* ------------------------------------------------------------------ */

const G_KEY = () => cred("GOOGLE_CSE_KEY");
const G_CX = () => cred("GOOGLE_CSE_CX");
// Soft per-RUN cap on free queries so one big run can't burn the whole daily 100.
// (The hard daily limit is enforced by Google with a 429; we stop early on that too.)
const G_MAX_QUERIES = () => {
  const n = parseInt(cred("GOOGLE_CSE_MAX_QUERIES") || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 60;
};

export function googleSearchConfigured(): boolean {
  return Boolean(G_KEY() && G_CX());
}

/** Map one Custom Search result item (a public LinkedIn profile) to a CandidateRow. */
function mapGoogleItem(o: any): CandidateRow | null {
  const link = str(o && o.link);
  if (!link || !/linkedin\.com\/in\//i.test(link)) return null; // only person profiles
  const url = link.split("?")[0];
  const mt = o.pagemap && Array.isArray(o.pagemap.metatags) ? o.pagemap.metatags[0] : null;
  // Title is usually "Name - Headline | LinkedIn"; strip the LinkedIn tail.
  let title = (str(o.title) || "").replace(/\s*[|\-–—]\s*LinkedIn.*$/i, "").trim();
  let fullName = title;
  let headline: string | undefined;
  const dash = title.split(/\s+[-–—]\s+/);
  if (dash.length > 1) { fullName = dash[0].trim(); headline = dash.slice(1).join(" - ").trim(); }
  if (mt) headline = headline || str(mt["og:description"]);
  const snippet = str(o.snippet);
  // Company from "... at X" in the headline/snippet (best-effort).
  let company: string | undefined;
  const hay = [headline, snippet].filter(Boolean).join(" ");
  const m = hay && hay.match(/\bat\s+([A-Za-z0-9][\w&.,'’\-]*(?:\s+[A-Za-z0-9][\w&.,'’\-]*){0,4})/);
  if (m) company = m[1].split(/[|·•–—]| - /)[0].trim() || undefined;
  if (!fullName) return null;
  return {
    fullName,
    title: headline,
    headline: headline || snippet,
    company,
    location: undefined, // CSE snippets rarely carry a clean location; let the scorer skip it
    linkedinUrl: url,
    imageUrl: (mt && str(mt["og:image"])) || undefined,
    fitScore: 0,
    fitReasons: [],
    provider: "google",
  };
}

/**
 * One Custom Search page (10 results). `page` is 1-based; CSE caps at 100 results
 * (start ≤ 91), so pages beyond 10 return nothing. Each call spends one free query.
 */
async function googleXraySearch(xray: string, page: number): Promise<CandidateRow[]> {
  const start = (page - 1) * 10 + 1;
  if (start > 91) return [];
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(G_KEY())}` +
    `&cx=${encodeURIComponent(G_CX())}&q=${encodeURIComponent(xray)}&num=10&start=${start}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const quota = res.status === 429 || /quota|rateLimit|dailyLimit/i.test(txt);
    throw Object.assign(new Error(`google ${res.status}${quota ? " (daily quota exhausted)" : ""}`), { quota });
  }
  const data = await res.json().catch(() => ({}));
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.map(mapGoogleItem).filter((r: CandidateRow | null): r is CandidateRow => Boolean(r));
}

/** Live health check for the Connected → JD Sourcing "Test connection" on the Google engine. */
export async function verifyGoogleSearch(): Promise<{ ok: boolean; error?: string; found?: number }> {
  if (!G_KEY()) return { ok: false, error: "Add your Google API key first." };
  if (!G_CX()) return { ok: false, error: "Add the Programmable Search engine ID (cx) first." };
  try {
    const rows = await googleXraySearch('site:linkedin.com/in recruiter', 1);
    return { ok: true, found: rows.length };
  } catch (e: any) {
    return { ok: false, error: (e && e.message) || "search request failed" };
  }
}

/* ------------------------------------------------------------------ */
/* SearXNG x-ray provider (free, self-hosted, always-on)               */
/* ------------------------------------------------------------------ */

// The SearXNG container the In-Market engine already runs. Sourcing reuses it so the
// tool ALWAYS has a working engine, even with zero paid keys configured.
const SEARX_URL = () =>
  (process.env.SOURCING_SEARXNG_URL || process.env.INMARKET_SEARXNG_URL || "").replace(/\/$/, "");

export function searxSearchConfigured(): boolean {
  return Boolean(SEARX_URL());
}

/** Map one SearXNG result (title/url/content) like a Google CSE item. */
function mapSearxItem(o: { url?: string; title?: string; content?: string }): CandidateRow | null {
  const link = str(o.url);
  if (!link || !/linkedin\.com\/in\//i.test(link)) return null; // only person profiles
  const url = link.split("?")[0];
  let title = (str(o.title) || "").replace(/\s*[|\-–—]\s*LinkedIn.*$/i, "").trim();
  let fullName = title;
  let headline: string | undefined;
  const dash = title.split(/\s+[-–—]\s+/);
  if (dash.length > 1) { fullName = dash[0].trim(); headline = dash.slice(1).join(" - ").trim(); }
  const snippet = str(o.content);
  let company: string | undefined;
  const hay = [headline, snippet].filter(Boolean).join(" ");
  const m = hay && hay.match(/\bat\s+([A-Za-z0-9][\w&.,'’\-]*(?:\s+[A-Za-z0-9][\w&.,'’\-]*){0,4})/);
  if (m) company = m[1].split(/[|·•–—]| - /)[0].trim() || undefined;
  if (!fullName) return null;
  return {
    fullName,
    title: headline,
    headline: headline || snippet,
    company,
    location: undefined, // snippets rarely carry a clean location; the scorer skips it
    linkedinUrl: url,
    fitScore: 0,
    fitReasons: [],
    provider: "searx",
  };
}

/** One SearXNG page for the X-ray boolean. Meta-search fans out server-side. */
async function searxXraySearch(xray: string, page: number): Promise<CandidateRow[]> {
  const url = `${SEARX_URL()}/search?q=${encodeURIComponent(xray)}&format=json&pageno=${page}`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`searx ${res.status}`);
  const data = await res.json().catch(() => ({}));
  const items = Array.isArray((data as any)?.results) ? (data as any).results : [];
  return items.map(mapSearxItem).filter((r: CandidateRow | null): r is CandidateRow => Boolean(r));
}

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

/** Stable dedupe key: LinkedIn URL when present, else name+company. */
function keyOf(r: CandidateRow): string {
  return (r.linkedinUrl || `${r.fullName}|${r.company ?? ""}`).toLowerCase().replace(/\/+$/, "");
}

/** Public alias of the dedupe key — callers record/compare the cross-run "seen" set with this. */
export function candidateKey(r: CandidateRow): string {
  return keyOf(r);
}

export interface DiscoveryResult {
  candidates: CandidateRow[];
  warnings: string[];
  /** Rows seen before threshold/cap filtering (for the UI's "scanned N" line). */
  scanned: number;
}

/**
 * NEVER-EMPTY SAFEGUARD: when the engines DID find people but our own filters
 * (strict location, fit bar) discarded every one of them, returning zero wastes the
 * spend and reads as a broken product. Degrade gracefully in two steps instead:
 *   1) Strict-location relax: score the geo-dropped rows and keep the ones that
 *      clear the fit bar, each marked `outOfArea` so the recruiter sees why.
 *   2) Fit-bar relax: if still empty, keep the strongest rows found anyway (capped
 *      at 25), so the recruiter always sees the best of what came back.
 * Hard-disqualified rows (score 0) are never rescued. Returns null only when there
 * is genuinely nothing worth showing. Exported for tests.
 */
export function rescueEmptyRun(
  geoBuffer: CandidateRow[],
  fitBuffer: CandidateRow[],
  icp: CandidateICP,
  minFit: number,
  cap: number,
): { candidates: CandidateRow[]; note: string } | null {
  const byK = new Map<string, CandidateRow>();
  for (const r of geoBuffer) {
    const sc = scoreCandidate(r, icp);
    r.fitScore = sc.fitScore;
    r.fitReasons = sc.fitReasons;
    r.outOfArea = true;
    const k = keyOf(r);
    const prev = byK.get(k);
    if (!prev || r.fitScore > prev.fitScore) byK.set(k, r);
  }
  const geoKept = [...byK.values()]
    .filter((r) => r.fitScore >= minFit && r.fitScore > 0)
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, cap);
  if (geoKept.length) {
    return {
      candidates: geoKept,
      note: `Nobody found stated a location inside the target area, so the ${geoKept.length} strongest matches are shown marked "out of area". To search without the location filter, check "Include out-of-area" in Advanced controls or widen the location.`,
    };
  }
  // Step 2: nothing clears the fit bar anywhere. Show the strongest of what WAS found.
  for (const r of fitBuffer) {
    const k = keyOf(r);
    const prev = byK.get(k);
    if (!prev || r.fitScore > prev.fitScore) byK.set(k, r);
  }
  const best = [...byK.values()]
    .filter((r) => r.fitScore > 0)
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, Math.min(25, cap));
  if (!best.length) return null;
  return {
    candidates: best,
    note: `Nothing scored above the fit bar (${minFit}), so the ${best.length} strongest people found are shown anyway. Lower Min fit in Advanced controls, or loosen the must-haves, to see more.`,
  };
}

/**
 * Run discovery across the queries and return a ranked, deduped, threshold-filtered
 * candidate list (highest fit first), capped at opts.cap (default 3000).
 */
export async function runDiscovery(
  queries: SourcingQuery[],
  icp: CandidateICP,
  opts: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const cap = Math.max(1, Math.min(opts.cap ?? 3000, 5000));
  const minFit = opts.minFit ?? 45;
  const engines = opts.engines ?? (["google", "searx", "rapidapi", "scraper"] as const);
  const warnings: string[] = [];

  let useGoogle = engines.includes("google") && googleSearchConfigured();
  let useSearx = engines.includes("searx") && searxSearchConfigured();
  const useRapid = engines.includes("rapidapi") && rapidApiSearchConfigured();
  const useScraper = engines.includes("scraper") && scraperConfigured();
  if (engines.includes("rapidapi") && !useRapid) {
    warnings.push("rapidapi_not_configured: set RAPIDAPI_KEY + RAPIDAPI_PEOPLE_SEARCH_HOST to enable scale discovery");
  }
  if (!useGoogle && !useSearx && !useRapid && !useScraper) {
    warnings.push("no_discovery_engine: nothing configured to find profiles, so the list will be empty");
    return { candidates: [], warnings, scanned: 0 };
  }

  const byKey = new Map<string, CandidateRow>();
  let scanned = 0;
  let geoDropped = 0;
  // SAFEGUARD buffers: nothing an engine found is thrown away irrecoverably. If the
  // run would otherwise end EMPTY, rescueEmptyRun() brings the best of these back
  // (marked), so a paid search can never return zero while profiles were found.
  const geoBuffer: CandidateRow[] = []; // strict-location drops, un-scored
  const fitBuffer: CandidateRow[] = []; // scored below the fit bar (top slice kept)

  // Score, threshold, and dedupe a batch of raw rows into byKey. Returns how many
  // cleared the fit threshold (used to gauge per-query saturation). Shared by every engine.
  function absorb(rows: CandidateRow[], group: string): number {
    let kept = 0;
    for (const r of rows) {
      // Cross-run "seen" memory: skip anyone already surfaced in a prior run (fresh-only mode).
      if (opts.excludeKeys && opts.excludeKeys.has(keyOf(r))) continue;
      scanned++;
      // Strict location: the recruiter pinned a hiring area, so a row that states a
      // DIFFERENT location is dropped outright (unknown locations are kept — the
      // scorer stays neutral on those and enrichment can resolve them later).
      if (opts.strictGeo && icp.geos && icp.geos.length && inTargetGeo(r.location, icp.geos) === false) {
        geoDropped++;
        r.sourceGroup = r.sourceGroup || group;
        if (geoBuffer.length < 2000) geoBuffer.push(r);
        continue;
      }
      r.sourceGroup = r.sourceGroup || group;
      const sc = scoreCandidate(r, icp);
      r.fitScore = sc.fitScore; r.fitReasons = sc.fitReasons;
      if (r.fitScore < minFit) {
        // Keep the strongest sub-threshold rows for the empty-run rescue (0 = disqualified, never kept).
        if (r.fitScore > 0) {
          fitBuffer.push(r);
          if (fitBuffer.length > 400) {
            fitBuffer.sort((a, b) => b.fitScore - a.fitScore).length = 200;
          }
        }
        continue;
      }
      const k = keyOf(r);
      const prev = byKey.get(k);
      // Keep the higher-scoring row, and prefer a richer provider on a tie (rapidapi/
      // scraper carry location etc. that the free Google pass usually lacks).
      if (!prev || r.fitScore > prev.fitScore) byKey.set(k, r);
      kept++;
    }
    return kept;
  }

  // Per-query budget so one big company doesn't starve the others.
  const perQuery = Math.max(20, Math.ceil(cap / Math.max(1, queries.length)) + 20);
  // Spread the free daily Google quota across queries: a few pages each, run-capped.
  const googleBudget = G_MAX_QUERIES();
  let googleUsed = 0;

  outer: for (const query of queries) {
    let collected = 0;

    // 1) FREE first pass: Google X-ray over the boolean we already built.
    if (useGoogle && googleUsed < googleBudget) {
      const gPages = 3; // up to 30 free results per query before paying anyone
      for (let page = 1; page <= gPages && collected < perQuery && googleUsed < googleBudget; page++) {
        let rows: CandidateRow[] = [];
        try { rows = await googleXraySearch(query.xray, page); googleUsed++; }
        catch (err: any) {
          warnings.push(`google(${query.group} p${page}): ${err.message}`);
          if (err && err.quota) { useGoogle = false; } // daily limit hit — stop for the run
          break;
        }
        if (!rows.length) break; // exhausted this query on Google
        collected += absorb(rows, query.group);
        if (byKey.size >= cap) break outer;
      }
    }

    // 2) FREE always-on: the self-hosted SearXNG meta-search over the same X-ray.
    // No quota, no key — this is what guarantees a JD Sourcing run is never empty
    // just because a paid listing broke or was never configured.
    if (useSearx && collected < perQuery) {
      const sPages = 4;
      let searxErrors = 0;
      for (let page = 1; page <= sPages && collected < perQuery; page++) {
        let rows: CandidateRow[] = [];
        try { rows = await searxXraySearch(query.xray, page); }
        catch (err: any) {
          warnings.push(`searx(${query.group} p${page}): ${err.message}`);
          if (++searxErrors >= 2) { useSearx = false; } // container down — stop trying this run
          break;
        }
        if (!rows.length) break; // exhausted this query
        collected += absorb(rows, query.group);
        if (byKey.size >= cap) break outer;
      }
    }

    // 3) PAID scale: RapidAPI people-search for whatever the free passes didn't fill.
    if (useRapid && collected < perQuery) {
      const post = PS_METHOD() === "POST";
      // POST listings return a batch sized by `count` in one call (no paging);
      // GET listings page through results. Same handling of the rows either way.
      const maxPages = post ? 1 : 10;
      // Structured search ONLY when a filter carries a real numeric LinkedIn id (Fresh's
      // current_company / geocode_location / past_company are id-based, NOT names). With an
      // id the title goes in `name` and the id in its own param — far higher precision than a
      // fuzzy "VP Sales Coupa" keyword. With only names (today's default) we keep the keyword,
      // so there's no regression until a name→id resolver populates these fields.
      const curId = numericId(query.currentCompany);
      const geoId = numericId(query.geoLocation);
      const pastId = numericId(query.pastCompany);
      const structured = Boolean(curId || geoId || pastId);
      const name = structured
        ? (query.titleTerm || query.keyword || query.label || query.xray)
        : (query.keyword || query.label || query.xray);
      for (let page = 1; page <= maxPages && collected < perQuery; page++) {
        let rows: CandidateRow[] = [];
        try {
          rows = await rapidApiPeopleSearch({
            name, page, limit: PAGE_LIMIT(),
            currentCompany: curId,
            geoLocation: geoId,
            pastCompany: pastId,
          });
        } catch (err) {
          warnings.push(`rapidapi(${query.group}${post ? "" : " p" + page}): ${(err as Error).message}`);
          break; // stop this query on error; move on
        }
        if (!rows.length) break; // exhausted
        collected += absorb(rows, query.group);
        if (byKey.size >= cap) break outer;
      }
    }

    // 4) Best-effort scraper sidecar (dormant unless configured).
    if (useScraper && collected < perQuery) {
      try {
        const { profiles, warnings: w } = await scrapeSearchViaSidecar(query.linkedinUrl, Math.min(perQuery, 100));
        if (w?.length) warnings.push(...w.map((x) => `scraper(${query.group}): ${x}`));
        const rows: CandidateRow[] = profiles.map((p) => ({
          fullName: p.fullName,
          title: p.title,
          headline: p.headline,
          company: p.company,
          location: p.location,
          linkedinUrl: p.publicProfileUrl,
          imageUrl: p.imageUrl,
          fitScore: 0,
          fitReasons: [],
          sourceGroup: query.group,
          provider: "scraper",
        }));
        collected += absorb(rows, query.group);
        if (byKey.size >= cap) break outer;
      } catch (err) {
        warnings.push(`scraper(${query.group}): ${(err as Error).message}`);
      }
    }
  }

  if (googleUsed >= googleBudget && googleUsed > 0) {
    warnings.push(`google_budget_reached: spent the free pass on ${googleUsed} queries this run; remaining queries used paid engines`);
  }

  let candidates = Array.from(byKey.values())
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, cap);

  // NEVER-EMPTY SAFEGUARD: engines found people but every one was filtered out by us.
  // Rescue the best of them (marked) instead of returning a bug-shaped zero.
  let geoRescued = false;
  if (!candidates.length && (geoBuffer.length || fitBuffer.length)) {
    const rescue = rescueEmptyRun(geoBuffer, fitBuffer, icp, minFit, cap);
    if (rescue) {
      candidates = rescue.candidates;
      geoRescued = candidates.some((r) => r.outOfArea);
      warnings.push(rescue.note);
    }
  }

  if (geoDropped && !geoRescued) {
    warnings.push(`strict_location: dropped ${geoDropped} candidate(s) located outside the target geos (turn on "Include out-of-area" in Advanced controls to keep them)`);
  }

  // ZERO-RESULT DIAGNOSIS: when a run STILL comes back empty after the rescue, say WHY
  // in plain English at the top of the warnings, so the recruiter sees the cause
  // instead of a silent zero. Outcome-first wording; setup detail stays parenthetical.
  if (!candidates.length) {
    const rapid404 = warnings.filter((w) => w.startsWith("rapidapi(") && / 404/.test(w)).length;
    const reasons: string[] = [];
    if (rapid404) reasons.push(`the paid people search rejected ${rapid404} request(s) (its host/path in Setup points at a missing endpoint)`);
    if (!useGoogle && engines.includes("google")) reasons.push("the free Google pass is off (add the Google search key in Setup to turn it on)");
    if (!useSearx && engines.includes("searx")) reasons.push("the built-in free search engine did not respond");
    if (opts.excludeKeys?.size && scanned === 0) reasons.push(`Fresh only is ON and ${opts.excludeKeys.size} previously-surfaced people are being excluded (uncheck it to see the full list again)`);
    if (scanned > 0) reasons.push(`${scanned} profiles were found but every one was ruled out by the search profile's hard disqualifiers or scored 0 fit; loosen the disqualifiers or the job location and run again`);
    warnings.unshift("empty_run: " + (reasons.length ? reasons.join("; ") : "no engine returned results"));
  }

  // SUCCESSFUL-RUN CLEANUP: per-query engine failures emit one line per company/page,
  // which turns into a wall of "rapidapi(...) 429" noise under the results table. Once
  // candidates came back, collapse them into a single short note; the raw per-query
  // list only matters on an empty run, where the diagnosis above consumes it.
  if (candidates.length) {
    const perQuery = /^(rapidapi|scraper|google|searx)\(/;
    const noisy = warnings.filter((w) => perQuery.test(w));
    if (noisy.length) {
      const kept = warnings.filter((w) => !perQuery.test(w));
      const rateLimited = noisy.filter((w) => /\b429\b/.test(w)).length;
      const note =
        rateLimited === noisy.length
          ? `search coverage may be partial: the people-search API rate-limited ${rateLimited} of the queries (429)`
          : `search coverage may be partial: ${noisy.length} queries failed (${rateLimited} rate-limited)`;
      warnings.splice(0, warnings.length, note, ...kept);
    }
  }

  return { candidates, warnings, scanned };
}
