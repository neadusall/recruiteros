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
 *   - rapidapi: a marketplace LinkedIn/people-search listing (the chosen scale path).
 *       Configure RAPIDAPI_KEY + RAPIDAPI_PEOPLE_SEARCH_HOST/PATH to point at whatever
 *       listing you subscribe to. Listings differ, so the result mapping is defensive.
 *   - scraper: the Playwright sidecar (li_at cookie), best-effort people-search.
 *
 * If no engine is configured the run returns an empty list plus an explicit warning —
 * it never fabricates candidates.
 */

import type { CandidateICP, CandidateRow, DiscoveryOptions, SourcingQuery } from "./types";
import { scoreCandidate } from "./score";
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
    const rows = await rapidApiPeopleSearch("recruiter", 1, 3);
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
 *  - GET listings: query + page go in the URL (path may template {query}/{page}).
 *  - POST listings: a JSON body { keywords, count } (e.g. Linkedin Data Scraper API).
 * `term` is the search string (a plain keyword for POST, the X-ray/keyword for GET).
 */
async function rapidApiPeopleSearch(term: string, page: number, count: number): Promise<CandidateRow[]> {
  const host = PS_HOST();
  const headers: Record<string, string> = {
    "X-RapidAPI-Key": RAPIDAPI_KEY(), "X-RapidAPI-Host": host,
    Accept: "application/json", "Content-Type": "application/json",
  };

  let res: Response;
  if (PS_METHOD() === "POST") {
    // Body-based listing: the path is literal (no interpolation); search rides in the body.
    const url = `https://${host}${PS_PATH()}`;
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ keywords: term, count }) });
  } else {
    // GET listing. A path that carries {query}/{page} placeholders is treated as a FULL
    // template, so any listing's own parameter names work as-is — e.g. Fresh LinkedIn
    // Scraper's `/api/v1/search/people?name={query}&page={page}&limit=10`. Without
    // placeholders we fall back to the conventional ?query=&page= append.
    const raw = PS_PATH();
    const templated = raw.includes("{query}") || raw.includes("{page}");
    let path = raw.replace(/\{query\}/g, encodeURIComponent(term)).replace(/\{page\}/g, String(page));
    if (!templated) {
      const sep = path.includes("?") ? "&" : "?";
      path = `${path}${sep}query=${encodeURIComponent(term)}&page=${page}`;
    }
    res = await fetch(`https://${host}${path}`, { headers });
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
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

/** Stable dedupe key: LinkedIn URL when present, else name+company. */
function keyOf(r: CandidateRow): string {
  return (r.linkedinUrl || `${r.fullName}|${r.company ?? ""}`).toLowerCase().replace(/\/+$/, "");
}

export interface DiscoveryResult {
  candidates: CandidateRow[];
  warnings: string[];
  /** Rows seen before threshold/cap filtering (for the UI's "scanned N" line). */
  scanned: number;
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
  const engines = opts.engines ?? (["google", "rapidapi", "scraper"] as const);
  const warnings: string[] = [];

  let useGoogle = engines.includes("google") && googleSearchConfigured();
  const useRapid = engines.includes("rapidapi") && rapidApiSearchConfigured();
  const useScraper = engines.includes("scraper") && scraperConfigured();
  if (engines.includes("rapidapi") && !useRapid) {
    warnings.push("rapidapi_not_configured: set RAPIDAPI_KEY + RAPIDAPI_PEOPLE_SEARCH_HOST to enable scale discovery");
  }
  if (!useGoogle && !useRapid && !useScraper) {
    warnings.push("no_discovery_engine: nothing configured to find profiles — list will be empty");
    return { candidates: [], warnings, scanned: 0 };
  }

  const byKey = new Map<string, CandidateRow>();
  let scanned = 0;

  // Score, threshold, and dedupe a batch of raw rows into byKey. Returns how many
  // cleared the fit threshold (used to gauge per-query saturation). Shared by every engine.
  function absorb(rows: CandidateRow[], group: string): number {
    let kept = 0;
    for (const r of rows) {
      scanned++;
      r.sourceGroup = r.sourceGroup || group;
      const sc = scoreCandidate(r, icp);
      r.fitScore = sc.fitScore; r.fitReasons = sc.fitReasons;
      if (r.fitScore < minFit) continue;
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

    // 2) PAID scale: RapidAPI people-search for whatever the free pass didn't fill.
    if (useRapid && collected < perQuery) {
      const post = PS_METHOD() === "POST";
      // POST listings return a batch sized by `count` in one call (no paging);
      // GET listings page through results. Same handling of the rows either way.
      const maxPages = post ? 1 : 10;
      for (let page = 1; page <= maxPages && collected < perQuery; page++) {
        let rows: CandidateRow[] = [];
        try {
          // Keyword-first: modern people-search listings take a plain keyword (role + company/geo),
          // not a Google X-ray boolean. Fall back to the X-ray only if no keyword was generated.
          const term = query.keyword || query.label || query.xray;
          rows = await rapidApiPeopleSearch(term, page, Math.min(perQuery, 100));
        } catch (err) {
          warnings.push(`rapidapi(${query.group}${post ? "" : " p" + page}): ${(err as Error).message}`);
          break; // stop this query on error; move on
        }
        if (!rows.length) break; // exhausted
        collected += absorb(rows, query.group);
        if (byKey.size >= cap) break outer;
      }
    }

    // 3) Best-effort scraper sidecar (dormant unless configured).
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

  const candidates = Array.from(byKey.values())
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, cap);

  return { candidates, warnings, scanned };
}
