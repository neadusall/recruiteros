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
 *   - serper: Serper.dev serving real Google results over the same X-ray Boolean.
 *       CHEAP paid (roughly $0.30-$1.00 per 1,000 searches vs CSE's $5/1,000), no
 *       daily cap, and it outlives the CSE JSON API (Google retires it Jan 1, 2027).
 *       Configure SERPER_API_KEY; runs after the free passes, before rapidapi, so the
 *       cheap key absorbs volume the expensive listing would otherwise carry.
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
 * LOCATION SPLIT: when the recruiter pinned a hiring area (strictGeo), the run is
 * GEO-ONLY by default — people stating a different location are left out (and said
 * so in a warning) so paid downstream steps never spend on non-locals. Opting in
 * (keepOutOfArea) returns them as a bounded "outside target area" appendix (each row
 * marked `outOfArea`) AFTER the in-area list, never interleaved.
 *
 * NEVER-EMPTY SAFEGUARD: when engines DO find people but the fit bar would discard
 * every one of them, rescueEmptyRun() brings the strongest back, explained in a
 * warning, instead of returning a zero-row result for a run that actually found
 * profiles.
 */

import type { CandidateICP, CandidateRow, DiscoveryOptions, SearchBreadth, SourcingQuery } from "./types";
import { scoreCandidate, inTargetGeo, US_STATE_FULL, type ScoreOptions } from "./score";
import { buildProofPlan } from "./proofPlan";
import { extractProofTerms, roleSignature } from "./proofExtract";
import { recordTermYield, termStatsFor } from "./proofStats";
import type { ProofTerm } from "./proofTerms";
import {
  distanceFromCenter, enforcedRadiusMi, geocodeUsPlace, stateOfPlace, statesWithinRadius,
  stripRadiusSuffix, withinRadius,
} from "./geoRadius";
import { scraperConfigured, scrapeSearchViaSidecar } from "../linkedin/scraperProvider";
import { rewriteSiteOperators } from "../serpRewrite";
import { cred } from "../providers/http";
import { koldinfoWorkerReady } from "./laxis";
import { submitDbDiscovery, collectDbDiscovery } from "./koldinfoDiscovery";
import { noteRapidQuota } from "./rapidQuota";

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

/** The listing host the people search is pointed at, for health/quota reporting. */
export function peopleSearchHost(): string {
  return PS_HOST();
}

/**
 * A people-search failure that RETRYING CANNOT FIX: the key was refused, the
 * subscription is gone, or the listing has no such endpoint. Every remaining query in
 * the run would fail identically — and still bill — so the run marks the engine dead
 * on the first one instead of repeating it once per query per page.
 *
 * This class exists because the opposite used to happen: a dead key produced one
 * `rapidapi(group p1): ... 403` warning per query, which the successful-run cleanup
 * then collapsed into "search coverage may be partial", wording that reads like a rate
 * limit. A wrong key looked like a busy afternoon.
 */
export class PeopleSearchFatal extends Error {
  readonly fatal = true;
  constructor(message: string) {
    super(message);
    this.name = "PeopleSearchFatal";
  }
}

/** True for an error that should stop the whole engine, not just the current query. */
export function isPeopleSearchFatal(e: unknown): e is PeopleSearchFatal {
  return Boolean(e && typeof e === "object" && (e as { fatal?: boolean }).fatal === true);
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
    // Same rule as the wide-web probes: a listing that answers but returns nobody is
    // not a pass, and one blank answer is not proof, so it gets a second look.
    return probeResult(
      await probeTwice(() => rapidApiPeopleSearch({ name: "recruiter", page: 1, limit: 3 })),
      "The people-search listing",
    );
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

/**
 * Ride out per-second/minute burst limits: the breadth dial fans out many queries and
 * marketplace listings 429 the burst even with plenty of monthly credits left - each
 * 429'd query used to be dropped outright (reported as "rate-limited N of the queries").
 * Honor Retry-After when sent, otherwise back off 2s/5s/12s before giving the query up.
 */
async function fetchRetry429(doFetch: () => Promise<Response>): Promise<Response> {
  const waits = [2000, 5000, 12000];
  let res = await doFetch();
  for (let i = 0; i < waits.length && res.status === 429; i++) {
    const ra = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : waits[i];
    await new Promise((r) => setTimeout(r, wait));
    res = await doFetch();
  }
  return res;
}

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
    const bodyObj: Record<string, unknown> = { keywords: p.name, count: p.limit };
    if (p.currentCompany) bodyObj.current_company = p.currentCompany;
    if (p.geoLocation) bodyObj.geocode_location = p.geoLocation;
    if (p.pastCompany) bodyObj.past_company = p.pastCompany;
    if (p.headcount) bodyObj.company_headcount = p.headcount;
    const body = JSON.stringify(bodyObj);
    const postTo = (path: string) => fetch(`https://${host}${path}`, { method: "POST", headers, body });

    const raw = effectivePsPath(host);
    res = await fetchRetry429(() => postTo(raw));

    // SELF-HEAL, same as the GET branch below. This used to be GET-only, so a POST
    // listing that renamed its endpoint had no recovery at all and every query in every
    // run 404'd against a path nobody would think to re-check.
    if (res.status === 404 && !(healedPath && healedPath.host === host)) {
      for (const variant of PS_PATH_VARIANTS) {
        if (variant === raw.split("?")[0]) continue;
        const tryRes = await postTo(variant).catch(() => null);
        if (tryRes && tryRes.status !== 404) {
          healedPath = { host, path: variant };
          res = tryRes;
          break;
        }
      }
      if (!(healedPath && healedPath.host === host)) {
        throw new PeopleSearchFatal(
          `rapidapi ${host} 404 (no people-search endpoint answered on this listing; tried the configured path "${raw}" and ${PS_PATH_VARIANTS.join(", ")}. ` +
          `Fix RAPIDAPI_PEOPLE_SEARCH_HOST/PATH in Setup, or subscribe to a listing that has a people search)`
        );
      }
    }
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
    res = await fetchRetry429(() => fetch(`https://${host}${buildPath(raw)}`, { headers }));

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
        throw new PeopleSearchFatal(
          `rapidapi ${host} 404 (no people-search endpoint answered on this listing; tried the configured path and ${PS_PATH_VARIANTS.join(", ")}. ` +
          `Fix RAPIDAPI_PEOPLE_SEARCH_HOST/PATH in Setup, or subscribe to a listing with a people search)`
        );
      }
    }
  }
  // Credit meter: every response (errors included, a 429 still reports the pool)
  // carries the subscription's quota headers; remember the latest reading.
  noteRapidQuota(host, res.headers);
  if (!res.ok) {
    // 401/403 = the key itself. Retrying, paging or moving to the next query cannot
    // change the answer, so this ends the engine for the run rather than being logged
    // once per query and buried. 402 is RapidAPI's "plan exhausted / not subscribed".
    if (res.status === 401 || res.status === 403 || res.status === 402) {
      throw new PeopleSearchFatal(
        `rapidapi ${host} ${res.status} (the RapidAPI key was refused, or this account is not subscribed to this listing / has run out of plan requests). ` +
        `Check the key and the subscription in Setup -> JD Sourcing.`
      );
    }
    throw new Error(`rapidapi ${host} ${res.status}`);
  }
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

/* ------------------------------------------------------------------ */
/* Snippet location parsing (shared by the web/X-ray mappers)          */
/* ------------------------------------------------------------------ */

// Words that can start a "Word, State" fragment without being a place ("Vice
// President, Georgia Market" must NOT become a location of "President, Georgia").
const NOT_A_CITY = /\b(president|director|manager|officer|chief|head|lead|vp|svp|evp|avp|rvp|sales|marketing|engineer|engineering|consultant|recruiter|recruiting|partner|principal|executive|analyst|specialist|coordinator|university|college|institute|llc|inc|corp|company|division|region|market|team)\b/i;

const STATE_FULL_SET = new Set(Object.values(US_STATE_FULL));

/**
 * Best-effort location from a Google/Serper/SearXNG snippet. LinkedIn profile
 * snippets usually DO state the person's location — either an explicit
 * "Location: Dallas, Texas" field or a "Dallas, Texas, United States ·" fragment —
 * the old mappers just never read it (every web row shipped location: undefined).
 * Parsing it makes the geo scoring and the strict-location filter work on web
 * results, which is what keeps the wide/geo-free searches honest.
 *
 * Deliberately conservative: only an explicit Location: field, a "City, <US state>"
 * shape, or a "Greater <City> Area" wording is taken; anything ambiguous returns
 * undefined, which the scorer and filters already treat as neutral (row kept).
 */
export function locationFromSnippet(hay: string | undefined): string | undefined {
  if (!hay) return undefined;
  const clean = (s: string): string => s.replace(/,?\s*United States\.?\s*$/i, "").replace(/\s+/g, " ").trim();
  // 1) The explicit field LinkedIn puts in og:description: "Location: Dallas, Texas".
  const m1 = hay.match(/\bLocation:\s*([^·•|;]{2,60}?)(?=\s*[·•|;]|\s*$)/i);
  if (m1) {
    const v = clean(m1[1]);
    if (v && v.length <= 60 && !NOT_A_CITY.test(v)) return v;
  }
  // 2) "City, ST" / "City, State" with a REAL US state (list-checked, so "Paris,
  //    Texas" passes and "President, Georgia Market"-style title text is rejected).
  //    Scans every fragment: one invalid hit must not mask a real location later on.
  const cityState = /([A-Z][A-Za-z.'’-]+(?:[ -][A-Z&][A-Za-z.'’-]*){0,3}),\s+([A-Z]{2}\b|[A-Z][a-z]+(?: [A-Z][a-z]+)?)/g;
  for (let m2 = cityState.exec(hay); m2; m2 = cityState.exec(hay)) {
    const city = m2[1].trim();
    const st = m2[2].trim();
    const known = st.length === 2 ? Boolean(US_STATE_FULL[st.toLowerCase()]) : STATE_FULL_SET.has(st.toLowerCase());
    if (known && !NOT_A_CITY.test(city)) return `${city}, ${st}`;
  }
  // 3) The metro wording profiles favor: "Greater Chicago Area", "Greater Boston".
  const m3 = hay.match(/\b(Greater [A-Z][A-Za-z.'’-]+(?: [A-Z][A-Za-z.'’-]+)?(?: Area)?)\b/);
  if (m3 && !NOT_A_CITY.test(m3[1])) return m3[1];
  return undefined;
}

/** Map one Custom Search result item (a public LinkedIn profile) to a CandidateRow. */
function mapGoogleItem(o: any): CandidateRow | null {
  const link = str(o && o.link);
  if (!link || !/linkedin\.com\/in\//i.test(link)) return null; // only person profiles
  // ...and LinkedIn's OWN marketing pages are not people. business.linkedin.com/in/en/
  // hire/recruiter satisfies the test above and would enter the list as a candidate
  // named "LinkedIn Recruiter". A live DataForSEO probe returned two of these in the
  // first six "profiles" for a generic term, so this matters more now that the wide-web
  // pass is carrying the run.
  if (/\/\/(business|premium|learning|talent|enterprise|sales|engineering|news|about)\.linkedin\.com/i.test(link)) return null;
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
    // KEEP THE SNIPPET. It used to be collapsed into `headline` only when no headline
    // existed, and otherwise dropped on the floor. It is the richest free text a search
    // result carries: a line or two of the About section, which is exactly where the
    // qualifying evidence lives ("CPA", "ASC 740", "BCBA", "PointClickCare"). Scoring
    // now reads it (see proofTerms), so throwing it away was throwing away the whole
    // long-tail signal we had already paid the search to fetch.
    snippet: snippet || undefined,
    company,
    // Parsed from the snippet/meta when clearly stated; undefined stays neutral.
    location: locationFromSnippet([mt && str(mt["og:description"]), snippet, headline].filter(Boolean).join(" · ")),
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
/**
 * The probe query every wide-web "Test connection" fires.
 *
 * It has to LOOK like a real x-ray — a quoted job title restricted to profile URLs —
 * because the obvious short form ('site:linkedin.com/in recruiter') mostly returns
 * LinkedIn's own product pages (business.linkedin.com/in/en/hire/recruiter), not people.
 * That made a green test prove only that the vendor was reachable, never that profiles
 * came back, which is precisely the gap that let these engines sit "healthy" while
 * contributing nothing.
 */
const PROBE_XRAY = 'site:linkedin.com/in "VP of Sales"';

/**
 * Run a probe, retrying ONCE when it comes back empty.
 *
 * Google — through any vendor — intermittently answers a perfectly good x-ray with a
 * blank page. Measured on this account: `"linkedin.com/in" "VP of Sales"` returned 19
 * organic results and 0 within the same minute. Without this retry the health watch
 * would flap a healthy engine to "down" and page the owner over nothing.
 */
async function probeTwice(fn: () => Promise<CandidateRow[]>): Promise<CandidateRow[]> {
  const rows = await fn();
  return rows.length ? rows : fn();
}

/** A wide-web probe that answered but found nobody is not a pass. */
function probeResult(rows: CandidateRow[], vendor: string): { ok: boolean; error?: string; found?: number } {
  if (!rows.length) {
    return {
      ok: false, found: 0,
      error: `${vendor} answered but returned no LinkedIn profiles for a broad test query — the account is reachable, the results are not.`,
    };
  }
  return { ok: true, found: rows.length };
}

export async function verifyGoogleSearch(): Promise<{ ok: boolean; error?: string; found?: number }> {
  if (!G_KEY()) return { ok: false, error: "Add your Google API key first." };
  if (!G_CX()) return { ok: false, error: "Add the Programmable Search engine ID (cx) first." };
  try {
    return probeResult(await probeTwice(() => googleXraySearch(PROBE_XRAY, 1)), "Google");
  } catch (e: any) {
    return { ok: false, error: (e && e.message) || "search request failed" };
  }
}

/* ------------------------------------------------------------------ */
/* Serper.dev x-ray provider (cheap paid Google results)               */
/* ------------------------------------------------------------------ */

// Serper.dev serves real Google results for roughly $0.30-$1.00 per 1,000 searches
// (vs the retiring Custom Search JSON API's $5/1,000 over a 100/day free cap). Same
// X-ray boolean, same result shape, no daily ceiling.
const SERPER_KEY = () => cred("SERPER_API_KEY");
// Soft per-RUN cap so one big run can't silently burn a pile of credits. At Serper's
// pricing even the wide-mode 300 is well under a dime; SERPER_MAX_QUERIES in Setup
// overrides the breadth-based default either way.
const SERPER_MAX_QUERIES = (fallback = 100) => {
  const n = parseInt(cred("SERPER_MAX_QUERIES") || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function serperSearchConfigured(): boolean {
  return Boolean(SERPER_KEY());
}

/**
 * One Serper page (10 organic results; `page` is 1-based). Organic items carry the
 * same title/link/snippet shape as a CSE item, so the Google mapper does the parsing;
 * only the provider tag differs.
 */
async function serperXraySearch(xray: string, page: number): Promise<CandidateRow[]> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": SERPER_KEY(), "Content-Type": "application/json" },
    body: JSON.stringify({ q: xray, num: 10, page }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const out = res.status === 429 || /credit|quota/i.test(txt);
    const bad = res.status === 401 || res.status === 403;
    // `quota` tells the orchestrator to stop the Serper pass for the rest of the run
    // (out of credits / bad key never self-heals mid-run).
    throw Object.assign(
      new Error(`serper ${res.status}${out ? " (out of credits or rate-limited)" : bad ? " (key rejected)" : ""}`),
      { quota: out || bad },
    );
  }
  const data = await res.json().catch(() => ({}));
  const items = Array.isArray((data as any)?.organic) ? (data as any).organic : [];
  return items
    .map(mapGoogleItem)
    .filter((r: CandidateRow | null): r is CandidateRow => Boolean(r))
    .map((r: CandidateRow) => ({ ...r, provider: "serper" }));
}

/** Live health check for the Connected → JD Sourcing "Test connection" on the Serper engine. */
export async function verifySerperSearch(): Promise<{ ok: boolean; error?: string; found?: number }> {
  if (!SERPER_KEY()) return { ok: false, error: "Add your Serper API key first." };
  try {
    return probeResult(await probeTwice(() => serperXraySearch(PROBE_XRAY, 1)), "Serper");
  } catch (e: any) {
    return { ok: false, error: (e && e.message) || "search request failed" };
  }
}

/* ------------------------------------------------------------------ */
/* DataForSEO x-ray provider (cheapest paid Google results)            */
/* ------------------------------------------------------------------ */

// DataForSEO serves real Google results, pay-as-you-go with no expiring credit
// bundle and native auto-recharge. COST REALITY (billed, 2026-08-14): DataForSEO
// multiplies the charge 5x for any keyword containing an advanced operator (site:,
// inurl:, intitle:, filetype:) — a depth-100 x-ray task billed $0.06, not the
// "fraction of a cent" this comment used to claim. The rewriteSiteOperators() call
// below dodges the surcharge by sending the site: restriction as a quoted phrase
// instead (measured: identical LinkedIn rows, 1/5th the bill; mapGoogleItem still
// hard-requires linkedin.com/in URLs, so the operator's guarantee is preserved).
// It stays BEFORE Serper because its balance cannot quietly expire the way Serper
// credits did on 2026-07-30 and again on 2026-08-12, and having two paid wide-web
// engines means a drained balance on one can no longer stall discovery.
const DFS_LOGIN = () => cred("DATAFORSEO_LOGIN");
const DFS_PASS = () => cred("DATAFORSEO_PASSWORD");
// Soft per-RUN cap, same shape as the Serper guard. Each task is up to 100 results,
// so even the default cap is a few dollars' worth of results at most.
const DFS_MAX_QUERIES = (fallback = 100) => {
  const n = parseInt(cred("DATAFORSEO_MAX_QUERIES") || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
/** Did the operator set an explicit cap? If so the run never raises it on their behalf. */
const DFS_CAP_EXPLICIT = (): boolean => {
  const n = parseInt(cred("DATAFORSEO_MAX_QUERIES") || "", 10);
  return Number.isFinite(n) && n > 0;
};

export function dataforseoSearchConfigured(): boolean {
  return Boolean(DFS_LOGIN() && DFS_PASS());
}

const dfsAuth = () =>
  "Basic " + Buffer.from(`${DFS_LOGIN()}:${DFS_PASS()}`).toString("base64");

/**
 * One DataForSEO live task: up to `depth` organic results in a single synchronous
 * call (no paging; depth replaces it). Items carry title/url/description, which map
 * onto the CSE title/link/snippet shape, so the Google mapper does the parsing.
 */
async function dataforseoXraySearch(xray: string, depth = 100): Promise<CandidateRow[]> {
  // site: → quoted phrase, or DataForSEO bills this task 5x (see the header note).
  const keyword = rewriteSiteOperators(xray).query.slice(0, 700);
  const res = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/regular", {
    method: "POST",
    headers: { Authorization: dfsAuth(), "Content-Type": "application/json" },
    body: JSON.stringify([{ keyword, location_code: 2840, language_code: "en", depth }]),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const out = res.status === 402 || res.status === 429 || /balance|payment|money/i.test(txt);
    const bad = res.status === 401 || res.status === 403;
    // `quota` stops the DataForSEO pass for the rest of the run (an empty balance or
    // rejected login never self-heals mid-run).
    throw Object.assign(
      new Error(`dataforseo ${res.status}${out ? " (balance empty or rate-limited)" : bad ? " (login rejected)" : ""}`),
      { quota: out || bad },
    );
  }
  const data: any = await res.json().catch(() => ({}));
  // DataForSEO answers HTTP 200 with per-payload status codes: 20000 = ok, 402xx =
  // payment problems. Surface those as real errors, not as an empty page.
  const task = Array.isArray(data?.tasks) ? data.tasks[0] : null;
  const code = Number(data?.status_code || 0);
  const taskCode = Number(task?.status_code || 0);
  if (code !== 20000 || (taskCode && taskCode !== 20000)) {
    const msg = String(task?.status_message || data?.status_message || "unexpected answer");
    const out = /money|balance|payment/i.test(msg) || String(taskCode).startsWith("402");
    throw Object.assign(new Error(`dataforseo ${taskCode || code} (${msg})`), { quota: out });
  }
  const items = Array.isArray(task?.result?.[0]?.items) ? task.result[0].items : [];
  return items
    .filter((it: any) => it && it.type === "organic")
    .map((it: any) => mapGoogleItem({ title: it.title, link: it.url, snippet: it.description }))
    .filter((r: CandidateRow | null): r is CandidateRow => Boolean(r))
    .map((r: CandidateRow) => ({ ...r, provider: "dataforseo" }));
}

/** Live health check for the Connected → JD Sourcing "Test connection" on the DataForSEO engine. */
export async function verifyDataForSeoSearch(): Promise<{ ok: boolean; error?: string; found?: number }> {
  if (!dataforseoSearchConfigured()) return { ok: false, error: "Add your DataForSEO API login and password first." };
  try {
    // Depth 20, not 100: measured here, depth 100 on this exact query returned 0 organic
    // results in the same minute depth 20 returned 19. A deep page is not a better probe.
    return probeResult(await probeTwice(() => dataforseoXraySearch(PROBE_XRAY, 20)), "DataForSEO");
  } catch (e: any) {
    return { ok: false, error: (e && e.message) || "search request failed" };
  }
}

/**
 * Account balance in USD via DataForSEO's FREE user-data endpoint; unlike Serper,
 * the health watch can check this vendor without spending anything. Returns null
 * when the call fails (callers treat that as "down", with the error attached).
 */
export async function dataforseoAccountBalance(): Promise<{ balance: number | null; error?: string }> {
  try {
    const res = await fetch("https://api.dataforseo.com/v3/appendix/user_data", {
      headers: { Authorization: dfsAuth() },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { balance: null, error: `dataforseo ${res.status}${res.status === 401 || res.status === 403 ? " (login rejected)" : ""}` };
    const data: any = await res.json().catch(() => ({}));
    const money = data?.tasks?.[0]?.result?.[0]?.money;
    const bal = Number(money?.balance);
    return Number.isFinite(bal) ? { balance: bal } : { balance: null, error: "no balance in the answer" };
  } catch (e: any) {
    return { balance: null, error: (e && e.message) || "request failed" };
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
    // Kept as evidence for proof-term scoring, same as the Google mapper above.
    snippet: snippet || undefined,
    company,
    // Parsed from the snippet when clearly stated; undefined stays neutral.
    location: locationFromSnippet(hay || undefined),
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

/** Minimal FIFO concurrency limiter: at most `n` callers inside `fn` at once. */
function makeLimiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: Array<() => void> = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= n) await new Promise<void>((res) => waiters.push(res));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const w = waiters.shift();
      if (w) w();
    }
  };
}

/** Public alias of the dedupe key — callers record/compare the cross-run "seen" set with this. */
export function candidateKey(r: CandidateRow): string {
  return keyOf(r);
}

/**
 * Why a run produced nobody, in a form the recruiter can READ and QUOTE.
 *
 * A search that finishes and shows nothing, with no reason on screen, is the worst
 * outcome the product has: the recruiter cannot tell a real "nobody matches" from an
 * outage, and the engineer gets a bug report that says "it went blank". So every empty
 * run carries one of these, the UI keeps it on screen until the next run, and `code` is
 * stable and safe to say out loud.
 *
 * `message` is recruiter-facing: plain, actionable, and it never names an engine, a key,
 * a query or a vendor. `detail` is the engineer-facing specifics behind the same code.
 */
export interface StopReason {
  /** Stable, quotable, e.g. "SRC-CREDITS". Safe to show and to read down the phone. */
  code: string;
  /** Recruiter-facing sentence. No vendor names, no internals. */
  message: string;
  /** Engineer-facing specifics. Shown only where internals are already allowed. */
  detail?: string;
}

export interface DiscoveryResult {
  candidates: CandidateRow[];
  warnings: string[];
  /** Present ONLY on an empty run: why, quotably. */
  stopReason?: StopReason;
  /** Rows seen before threshold/cap filtering (for the UI's "scanned N" line). */
  scanned: number;
  /** Quota'd search-API requests this run spent, by engine: the saved list's credit
   *  stamp (rapidapi = the paid people-search listing's monthly credits). */
  usage: { rapidapi: number; serper: number; google: number; dataforseo: number };
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
  /** Radius context, so a rescue re-scores on the same terms the run itself used. */
  scoreOpts: ScoreOptions = {},
): { candidates: CandidateRow[]; note: string } | null {
  const byK = new Map<string, CandidateRow>();
  for (const r of geoBuffer) {
    // Re-score WITH the radius context. Dropping it here let the keep-biased name
    // matcher hand a 300-mile person a better score than the radius-aware pass gave
    // them, so the rescue could rank someone far away above someone merely just
    // outside the line — and the row still carried a milesFromTarget that contradicted
    // its own stated reasons.
    const sc = scoreCandidate(r, icp, scoreOpts);
    r.fitScore = sc.fitScore;
    r.fitReasons = sc.fitReasons;
    r.outOfArea = true;
    const k = keyOf(r);
    const prev = byK.get(k);
    if (!prev || r.fitScore > prev.fitScore) byK.set(k, r);
  }
  const geoKept = [...byK.values()]
    .filter((r) => r.fitScore >= minFit && r.fitScore > 0)
    // Nearest first among equals: when we are forced to show out-of-area people, the
    // ones closest to the recruiter's target are the most salvageable.
    .sort((a, b) => b.fitScore - a.fitScore || (a.milesFromTarget ?? 1e9) - (b.milesFromTarget ?? 1e9))
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
  const engines = opts.engines ?? (["koldinfo", "google", "searx", "dataforseo", "serper", "rapidapi", "scraper"] as const);
  // Breadth deepens per-query paging (query fan-out already happened in generateQueries):
  // wide digs further into each search before giving up on it.
  const breadth: SearchBreadth = opts.breadth ?? "balanced";
  const sPages = breadth === "wide" ? 6 : 4; // SearXNG pages/query (free)
  const pPages = breadth === "wide" ? 8 : breadth === "balanced" ? 4 : 3; // Serper pages/query (pennies)
  const warnings: string[] = [];

  let useGoogle = engines.includes("google") && googleSearchConfigured();
  let useSearx = engines.includes("searx") && searxSearchConfigured();
  let useSerper = engines.includes("serper") && serperSearchConfigured();
  let useDfs = engines.includes("dataforseo") && dataforseoSearchConfigured();
  const useRapid = engines.includes("rapidapi") && rapidApiSearchConfigured();
  // Set the moment the listing proves it cannot serve this run at all (bad key, dead
  // endpoint, plan exhausted). Every later query skips the paid engine instead of
  // paying for the same refusal again.
  let rapidDead: string | null = null;
  const useScraper = engines.includes("scraper") && scraperConfigured();
  // The free contact-database sweep (title + geo over the Business Email DB). Needs
  // the browser worker up AND holding KoldInfo creds; the probe is cheap and local.
  const useKold = engines.includes("koldinfo") ? await koldinfoWorkerReady() : false;
  if (engines.includes("rapidapi") && !useRapid) {
    warnings.push("rapidapi_not_configured: set RAPIDAPI_KEY + RAPIDAPI_PEOPLE_SEARCH_HOST to enable scale discovery");
  }
  if (!useGoogle && !useSearx && !useSerper && !useDfs && !useRapid && !useScraper && !useKold) {
    warnings.push("no_discovery_engine: nothing configured to find profiles, so the list will be empty");
    return { candidates: [], warnings, scanned: 0, usage: { rapidapi: 0, serper: 0, google: 0, dataforseo: 0 } };
  }

  // Submit the database sweep FIRST so the worker browses KoldInfo while the web
  // X-ray pass below runs — the two overlap and the run collects both at the end.
  let koldJobId: string | null = null;
  let koldSubmittedAt = 0;
  if (useKold) {
    try {
      koldJobId = await submitDbDiscovery(icp, Math.min(cap, 500), {
        location: opts.remote === true ? "" : opts.geoCenter,
        radiusMi: opts.remote === true ? 0 : opts.radiusMi,
        remote: opts.remote === true,
      });
      koldSubmittedAt = Date.now();
    } catch (e) {
      warnings.push(`kolddb(submit): ${(e as Error).message}`);
    }
  }

  const byKey = new Map<string, CandidateRow>();
  // TWO SEPARATE LISTS when the recruiter pinned a hiring area: byKey holds people
  // inside the target geos (or with no stated location), outByKey holds people who
  // state a DIFFERENT location. Collecting the out-of-area block is OPT-IN
  // (keepOutOfArea): by default a geo'd run stays geo-only so paid downstream steps
  // never spend on non-locals. When opted in, the block is returned as its own
  // marked appendix AFTER the in-area list, never mixed into it.
  const keepOut = opts.keepOutOfArea === true;
  const outByKey = new Map<string, CandidateRow>();
  const OUT_CAP = Math.min(300, cap); // the out-of-area block is a bounded appendix, not the list
  // Radius state, resolved ONCE per run: the recruiter's mileage pick plus the coordinate
  // of the location they typed.
  //
  // THE MILEAGE IS A CEILING, NOT A HINT (owner mandate 2026-08-06). The center is
  // geocoded whenever a location was typed at all — including "Exact". Gating it on
  // `radiusMi > 0` meant the tightest setting on the dropdown silently disabled the only
  // real filter in the product and handed every row to the keep-biased name matcher,
  // which passes anyone sharing a state token. That is exactly how people hundreds of
  // miles out kept landing in a pinned search. "Exact" is now a measured 15mi
  // (EXACT_RADIUS_MI) rather than "unlimited".
  //
  // Only a center we genuinely cannot place on a map falls back to the string matcher.
  //
  // REMOTE runs sit outside all of it. There is no typed center, so there is no circle,
  // no distance to measure and nothing to be outside of — the radius machinery is turned
  // off at the source here rather than being fed a blank location and left to guess.
  const remote = opts.remote === true;
  const radiusMi = remote ? 0 : opts.radiusMi ?? 0;
  const geoLabel = remote ? "" : stripRadiusSuffix(opts.geoCenter || icp.geos?.[0] || "");
  // What the FILTER enforces (Exact = 15mi) vs what the recruiter picked (0 for Exact).
  const filterRadiusMi = remote ? 0 : enforcedRadiusMi(radiusMi);
  const geoCenter = geoLabel ? geocodeUsPlace(geoLabel) : null;
  // PROOF EVIDENCE for this run, assembled from all three layers: the curated library,
  // vocabulary derived for this role when no shelf covers its industry, and the measured
  // yield that retires terms this market does not actually use. Built here rather than
  // passed in so EVERY caller gets it (interactive run, overnight queue, Sales Nav import,
  // crash recovery) with no wiring of its own.
  //
  // Both enrichments are best-effort by design: a model hiccup or a cold stats ledger
  // must never stop a search, so each degrades to the layer beneath it.
  const roleSig = roleSignature(icp);
  const derived = await extractProofTerms(icp, "").catch(() => [] as ProofTerm[]);
  const termStats = opts.workspaceId
    ? await termStatsFor(opts.workspaceId, roleSig).catch(() => ({}))
    : {};
  const proofPlan = buildProofPlan(icp, "", { derived, stats: termStats });
  const proofTerms = proofPlan.terms;
  // Score against the ENFORCED radius, so an Exact search ranks by real miles too
  // instead of dropping to name matching the moment the dropdown says "Exact".
  const scoreOpts: ScoreOptions = {
    radiusMi: geoCenter ? filterRadiusMi : radiusMi,
    geoLabel,
    remote,
    proofTerms,
  };
  // Every state the circle touches, for the coarse fallback on rows we cannot place.
  const radiusStates = geoCenter ? statesWithinRadius(geoCenter, filterRadiusMi) : [];
  let scanned = 0;
  let geoDropped = 0;
  // SAFEGUARD buffers: sub-fit-bar rows and (in default geo-only mode) the out-of-area
  // drops are kept so a run that found people can never end empty — rescueEmptyRun
  // brings the strongest back, marked and explained, at zero extra engine spend.
  const fitBuffer: CandidateRow[] = []; // scored below the fit bar (top slice kept)
  const geoBuffer: CandidateRow[] = []; // out-of-area drops when keepOutOfArea is off

  // Score, threshold, and dedupe a batch of raw rows into byKey/outByKey. Returns how
  // many IN-AREA rows cleared the fit threshold (per-query saturation gauge) — out-of-
  // area rows don't count, so the engines keep digging for locals. Shared by every engine.
  function absorb(rows: CandidateRow[], group: string): number {
    let kept = 0;
    for (const r of rows) {
      // Cross-run "seen" memory: skip anyone already surfaced in a prior run (fresh-only mode).
      if (opts.excludeKeys && opts.excludeKeys.has(keyOf(r))) continue;
      scanned++;
      r.sourceGroup = r.sourceGroup || group;
      // Measure BEFORE scoring: the scorer reads milesFromTarget to award geo credit on
      // a sliding scale, so the distance has to be on the row by the time it runs.
      r.milesFromTarget = distanceFromCenter(r.location, geoCenter);
      const sc = scoreCandidate(r, icp, scoreOpts);
      r.fitScore = sc.fitScore; r.fitReasons = sc.fitReasons;
      // Strict location: a row that states a DIFFERENT location is marked for the
      // separate out-of-area list (unknown locations stay in the main list — the
      // scorer is neutral on those and enrichment can resolve them later).
      //
      // MEASURED FIRST: when the recruiter picked a radius and we located both the
      // center and this row, distance is the answer and the name matcher never runs —
      // that matcher is deliberately keep-biased and was letting same-state people
      // hundreds of miles out ride along as "in area". The string test stays as the
      // fallback for rows whose stated location will not geocode.
      let outside = false;
      // `!remote` is belt and braces: a remote run clears icp.geos, so the condition
      // below is already false. It is spelled out anyway because "nobody is ever dropped
      // for where they live" is the whole promise of the mode, and it should not depend
      // on a side effect of how the profile was shaped.
      if (!remote && opts.strictGeo && icp.geos && icp.geos.length) {
        const measured = withinRadius(r.location, geoCenter, filterRadiusMi);
        if (measured !== undefined) {
          outside = !measured;
        } else if (geoCenter) {
          // Radius mode, but this row's location would not resolve. Do NOT fall back to
          // the name matcher here: radius pinning replaced icp.geos with a short list of
          // the most prominent in-radius cities, so matching against it would drop real
          // locals from every town that did not make the list. Fall back one level of
          // precision instead — the STATE — and keep anything we cannot even place that
          // far, per the never-empty rule.
          const st = stateOfPlace(r.location);
          outside = Boolean(st && !radiusStates.includes(st));
          // We kept this row on a guess, not a measurement. Say so on the row: later
          // enrichment routinely fills in a real city, and enforceRunGeo re-measures
          // every unverified row the moment that happens, so a person whose location
          // only becomes readable AFTER the search can never ride into the deliverable
          // list as if the radius had cleared them.
          r.geoUnverified = true;
        } else {
          outside = inTargetGeo(r.location, icp.geos) === false;
          r.geoUnverified = true; // name matching is not a measurement either
        }
      }
      if (outside) r.outOfArea = true; // marked BEFORE buffering so rescued rows stay labeled
      if (outside || !opts.strictGeo) r.geoUnverified = undefined; // settled: measured out, or no geo filter asked for
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
      if (outside) {
        if (keepOut) {
          if (outByKey.size < OUT_CAP * 2) {
            const k = keyOf(r);
            const prev = outByKey.get(k);
            if (!prev || r.fitScore > prev.fitScore) outByKey.set(k, r);
          }
        } else {
          // Default geo-only mode: drop, but buffer for the never-empty rescue.
          geoDropped++;
          if (geoBuffer.length < 2000) geoBuffer.push(r);
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
  // The wide-web allowance, shared in spirit by the two paid SERP engines.
  const wideDefault = breadth === "wide" ? 300 : 100;
  // Serper is cheap but not free: a per-run soft cap keeps one big run's spend bounded.
  // Wide mode raises the default ceiling (more queries × deeper pages still lands
  // around a nickel a run); an explicit SERPER_MAX_QUERIES in Setup always wins.
  const serperBudget = SERPER_MAX_QUERIES(wideDefault);
  let serperUsed = 0;
  // DataForSEO: one task per query (depth covers what paging would), so the cap is
  // effectively "how many queries may use it".
  //
  // IT IS THE PRIMARY WIDE-WEB PASS, and Serper sits behind it as a top-up. So when
  // Serper cannot run at all — no key, or credits gone, which is the live state on this
  // box — DataForSEO has to be allowed to cover the queries Serper would have taken.
  // Otherwise every query past its own cap gets NO wide-web pass whatsoever, and the run
  // reports success having searched a fraction of what it was asked to. Real runs here
  // fan out to 57-319 queries against a default cap of 100, so that gap is the common
  // case, not the edge. An explicit DATAFORSEO_MAX_QUERIES always wins.
  let dfsBudget = DFS_MAX_QUERIES(useSerper ? wideDefault : wideDefault * 2);
  let dfsUsed = 0;
  // How many blank DataForSEO pages this run will pay to re-ask (see the retry below).
  const DFS_RETRY_BUDGET = 25;
  let dfsRetries = 0;
  // People-search listing requests attempted this run (its monthly credits are the
  // scarce paid resource, so the count is stamped onto the saved list).
  let rapidUsed = 0;

  // Queries run CONCURRENTLY (pool below) instead of strictly one after another —
  // the run collects the same rows, just without idle waiting between HTTP calls.
  // Each query still walks its engines in the same free→cheap→paid order, and
  // per-engine limiters keep every vendor at a burst it tolerates. The paid
  // people-search listing stays fully SERIAL (limit 1): its per-minute burst caps
  // 429'd even sequential runs, so its pacing must not change. absorb() and the
  // shared budgets are safe under this concurrency (single-threaded event loop;
  // budget counters are reserved synchronously before each call awaits).
  const gLimit = makeLimiter(2);
  const sxLimit = makeLimiter(4);
  const spLimit = makeLimiter(4);
  const dfLimit = makeLimiter(4);
  const raLimit = makeLimiter(1);
  const scLimit = makeLimiter(1);
  let capped = false; // replaces the sequential loop's `break outer`

  async function processQuery(query: SourcingQuery): Promise<void> {
    let collected = 0;

    // 1) FREE first pass: Google X-ray over the boolean we already built.
    if (useGoogle && googleUsed < googleBudget && !capped) {
      const gPages = 3; // up to 30 free results per query before paying anyone
      for (let page = 1; page <= gPages && collected < perQuery && !capped; page++) {
        if (googleUsed >= googleBudget) break;
        googleUsed++; // reserve BEFORE the await so concurrent queries can't overshoot the cap
        let rows: CandidateRow[] = [];
        try { rows = await gLimit(() => googleXraySearch(query.xray, page)); }
        catch (err: any) {
          warnings.push(`google(${query.group} p${page}): ${err.message}`);
          if (err && err.quota) { useGoogle = false; } // daily limit hit — stop for the run
          break;
        }
        if (!rows.length) break; // exhausted this query on Google
        collected += absorb(rows, query.group);
        if (byKey.size >= cap) { capped = true; return; }
      }
    }

    // 2) FREE always-on: the self-hosted SearXNG meta-search over the same X-ray.
    // No quota, no key — this is what guarantees a JD Sourcing run is never empty
    // just because a paid listing broke or was never configured.
    if (useSearx && collected < perQuery && !capped) {
      let searxErrors = 0;
      for (let page = 1; page <= sPages && collected < perQuery && !capped; page++) {
        let rows: CandidateRow[] = [];
        try { rows = await sxLimit(() => searxXraySearch(query.xray, page)); }
        catch (err: any) {
          warnings.push(`searx(${query.group} p${page}): ${err.message}`);
          if (++searxErrors >= 2) { useSearx = false; } // container down — stop trying this run
          break;
        }
        if (!rows.length) break; // exhausted this query
        collected += absorb(rows, query.group);
        if (byKey.size >= cap) { capped = true; return; }
      }
    }

    // 2.5) CHEAPEST paid: one DataForSEO live task over the same X-ray. Depth 100
    // makes it a single call per query (no paging), and per result it undercuts
    // Serper several times over, so it absorbs volume before Serper spends.
    if (useDfs && collected < perQuery && !capped && dfsUsed < dfsBudget) {
      dfsUsed++; // reserved before the await, same as the budgets above
      try {
        let rows = await dfLimit(() => dataforseoXraySearch(query.xray));
        // Google answers a perfectly good x-ray with a blank page now and then (measured:
        // the same query returned 19 results and 0 within a minute). DataForSEO is the
        // primary pass, so a transient blank silently costs the run that entire query.
        // Retry once — BUDGETED, because a query with genuinely no results would otherwise
        // double its own bill, and there is no way to tell the two apart from one answer.
        if (!rows.length && dfsRetries < DFS_RETRY_BUDGET && dfsUsed < dfsBudget) {
          dfsRetries++;
          dfsUsed++; // a retry is a real billed task; the budget stays an honest spend cap
          rows = await dfLimit(() => dataforseoXraySearch(query.xray));
        }
        if (rows.length) {
          collected += absorb(rows, query.group);
          if (byKey.size >= cap) { capped = true; return; }
        }
      } catch (err: any) {
        warnings.push(`dataforseo(${query.group}): ${err.message}`);
        if (err && err.quota) { useDfs = false; } // balance gone / login bad, stop for the run
      }
    }

    // 3) CHEAP paid: Serper.dev Google results over the same X-ray. Runs before the
    // expensive people-search listing so the pennies key absorbs volume first, and it
    // keeps digging when the CSE free pass ran dry (or was never / can no longer be
    // configured: Google closed the CSE API to new signups, retiring it Jan 1, 2027).
    if (useSerper && collected < perQuery && !capped) {
      for (let page = 1; page <= pPages && collected < perQuery && !capped; page++) {
        if (serperUsed >= serperBudget) break;
        serperUsed++; // reserved before the await, same as the Google budget above
        let rows: CandidateRow[] = [];
        try { rows = await spLimit(() => serperXraySearch(query.xray, page)); }
        catch (err: any) {
          warnings.push(`serper(${query.group} p${page}): ${err.message}`);
          if (err && err.quota) {
            useSerper = false; // credits gone / key bad, stop for the run
            // The top-up just retired mid-run. Hand its share to the primary pass, so a
            // Serper balance that empties halfway does not silently halve the run's reach.
            if (!DFS_CAP_EXPLICIT()) dfsBudget = Math.max(dfsBudget, wideDefault * 2);
          }
          break;
        }
        if (!rows.length) break; // exhausted this query on Serper
        collected += absorb(rows, query.group);
        if (byKey.size >= cap) { capped = true; return; }
      }
    }

    // 4) PAID scale: RapidAPI people-search for whatever the free passes didn't fill.
    if (useRapid && !rapidDead && collected < perQuery && !capped) {
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
      for (let page = 1; page <= maxPages && collected < perQuery && !capped; page++) {
        let rows: CandidateRow[] = [];
        rapidUsed++; // counted on attempt: an errored call may still bill
        try {
          rows = await raLimit(() => rapidApiPeopleSearch({
            name, page, limit: PAGE_LIMIT(),
            currentCompany: curId,
            geoLocation: geoId,
            pastCompany: pastId,
          }));
        } catch (err) {
          if (isPeopleSearchFatal(err)) {
            // The listing is wrong, not busy. Retire the engine for the whole run and
            // say so under its own prefix, so the successful-run cleanup below (which
            // collapses per-query engine noise into "coverage may be partial") cannot
            // dress a dead key up as a rate limit.
            rapidDead = (err as Error).message;
            warnings.push(
              `people_search_down: the paid people search stopped answering and was skipped for the rest of this run. ` +
              `${rapidDead}`
            );
            break;
          }
          warnings.push(`rapidapi(${query.group}${post ? "" : " p" + page}): ${(err as Error).message}`);
          break; // stop this query on error; move on
        }
        if (!rows.length) break; // exhausted
        collected += absorb(rows, query.group);
        if (byKey.size >= cap) { capped = true; return; }
      }
    }

    // 5) Best-effort scraper sidecar (dormant unless configured).
    if (useScraper && collected < perQuery && !capped) {
      try {
        const { profiles, warnings: w } = await scLimit(() =>
          scrapeSearchViaSidecar(query.linkedinUrl, Math.min(perQuery, 100)));
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
        if (byKey.size >= cap) { capped = true; return; }
      } catch (err) {
        warnings.push(`scraper(${query.group}): ${(err as Error).message}`);
      }
    }
  }

  {
    const pool = Math.min(4, Math.max(1, queries.length));
    let qi = 0;
    await Promise.all(Array.from({ length: pool }, async () => {
      while (!capped) {
        const query = queries[qi++];
        if (!query) return;
        await processQuery(query);
      }
    }));
  }

  // Collect the database sweep that was submitted before the web pass. Patience is
  // measured from SUBMIT (the web pass above already burned most of it), floored so
  // a fast web pass still gives the worker a fair window.
  if (koldJobId) {
    const patience = breadth === "wide" ? 240_000 : breadth === "focused" ? 90_000 : 150_000;
    const remaining = Math.max(20_000, patience - (Date.now() - koldSubmittedAt));
    const { rows, error } = await collectDbDiscovery(koldJobId, remaining);
    if (error) warnings.push(`kolddb(read): ${error}`);
    if (rows.length) absorb(rows, "contact database");
  }

  if (googleUsed >= googleBudget && googleUsed > 0) {
    warnings.push(`google_budget_reached: spent the free pass on ${googleUsed} queries this run; remaining queries used paid engines`);
  }
  if (serperUsed >= serperBudget && serperUsed > 0) {
    warnings.push(`serper_budget_reached: the Serper pass stopped after ${serperUsed} searches this run to keep spend bounded (raise SERPER_MAX_QUERIES in Setup to allow more)`);
  }
  if (dfsUsed >= dfsBudget && dfsUsed > 0) {
    warnings.push(`dataforseo_budget_reached: the DataForSEO pass stopped after ${dfsUsed} searches this run to keep spend bounded (raise DATAFORSEO_MAX_QUERIES to allow more)`);
  }

  // TWO-BLOCK RESULT: the in-area list is THE list; the out-of-area list is a bounded,
  // clearly labeled appendix after it. They are never interleaved, so "top N" actions
  // (deep-vet, promote order) always spend on the in-area people first.
  let inList = Array.from(byKey.values())
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, cap);
  let outList = Array.from(outByKey.values())
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, OUT_CAP);

  // NEVER-EMPTY SAFEGUARD: engines found people but our filters (geo drop, fit bar)
  // discarded every one. Rescue the strongest (they keep their in/out-of-area marks)
  // instead of returning a bug-shaped zero — no extra engine spend, the rows were
  // already fetched.
  let rescued = false;
  if (!inList.length && !outList.length && (geoBuffer.length || fitBuffer.length)) {
    const rescue = rescueEmptyRun(geoBuffer, fitBuffer, icp, minFit, cap, scoreOpts);
    if (rescue) {
      rescued = true;
      inList = rescue.candidates.filter((r) => !r.outOfArea);
      outList = rescue.candidates.filter((r) => r.outOfArea);
      warnings.push(rescue.note);
    }
  }

  const candidates = inList.concat(outList);

  // LEARN FROM THIS RUN. Fold how often each term actually appeared into the evidence
  // ledger, so the next run for this role ranks its vocabulary on measured reality rather
  // than on anyone's opinion, and terms that describe no real person get retired.
  // Deliberately counts the WHOLE harvest, not just the rows that survived the fit bar:
  // the question is what this market's people write on their profiles, and rows we
  // discarded are just as good evidence of that as rows we kept. Rows found BY a proof
  // query are excluded inside recordTermYield, since their evidence was guaranteed by the
  // boolean that found them. Fire-and-forget: a ledger write must never fail a search.
  if (opts.workspaceId && proofTerms.length) {
    const harvest = candidates.concat(geoBuffer, fitBuffer);
    void recordTermYield(opts.workspaceId, roleSig, proofTerms, harvest).catch(() => {});
  }

  if (geoDropped && !rescued) {
    warnings.push(`${geoDropped} matching people outside the target area were left out to keep this run geo-only (turn on "Also list out-of-area (separate list)" in Advanced controls to see them next run)`);
    // The filter ate most of the run: show WHERE the dropped people actually are, so
    // a misspelled or too-narrow City & state is visible instead of a silent thin
    // list (a one-letter typo once geo-dropped an entire metro's worth of matches).
    if (geoDropped >= 10 && geoDropped > inList.length * 2) {
      const counts = new Map<string, number>();
      for (const r of geoBuffer) {
        const loc = (r.location || "").trim();
        if (loc) counts.set(loc, (counts.get(loc) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([loc, n]) => `${loc} (${n})`).join(", ");
      if (top) {
        warnings.push(`Heads up: the location filter removed far more people than it kept. The dropped people mostly state: ${top}. If your City & state box is misspelled or too narrow, fix it and re-run; the search itself was fine.`);
      }
    }
  }
  if (keepOut && outList.length && !rescued) {
    warnings.push(
      inList.length
        ? `${outList.length} matches outside the target area are listed separately below the in-area results`
        : `Nobody found stated a location inside the target area, so all ${outList.length} matches are in the "Outside target area" list. Widen the location (or check "Include out-of-area" in Advanced controls) to search without the location split.`,
    );
  }

  // ZERO-RESULT DIAGNOSIS: when a run STILL comes back empty after the rescue, say WHY
  // in plain English at the top of the warnings, so the recruiter sees the cause
  // instead of a silent zero. Outcome-first wording; setup detail stays parenthetical.
  let stopReason: StopReason | undefined;
  if (!candidates.length) {
    const rapid404 = warnings.filter((w) => w.startsWith("rapidapi(") && / 404/.test(w)).length;
    const reasons: string[] = [];
    // rapidDead carries the precise cause (key refused / no such endpoint / plan spent);
    // rapid404 is the older per-query count, kept for listings that 404 without tripping
    // the fatal path.
    if (rapidDead) reasons.push(`the paid people search is not usable for this workspace (${rapidDead})`);
    else if (rapid404) reasons.push(`the paid people search rejected ${rapid404} request(s) (its host/path in Setup points at a missing endpoint)`);
    // The actionable fix for a run with no wide web search is a DataForSEO login: it is
    // the primary pass, it is pay-as-you-go with no bundle to expire, and Google closed
    // the CSE API to new signups (gone Jan 1, 2027), so don't send anyone there.
    if (!useGoogle && !useSerper && !useDfs && engines.includes("serper") && !serperSearchConfigured() && !dataforseoSearchConfigured()) {
      reasons.push("the wide web-search pass is off (add your DataForSEO login in Setup under JD Sourcing, in the Cheapest pass fields, then run again)");
    }
    if (!useDfs && engines.includes("dataforseo") && dataforseoSearchConfigured()) reasons.push("the DataForSEO pass — the primary wide web search — stopped early (login rejected or balance empty; check your app.dataforseo.com balance)");
    if (!useSerper && engines.includes("serper") && serperSearchConfigured()) reasons.push("the Serper top-up pass stopped early (key rejected or out of credits; check your serper.dev balance)");
    if (!useSearx && engines.includes("searx")) reasons.push("the built-in free search engine did not respond");
    if (engines.includes("koldinfo") && !useKold) reasons.push("the free contact-database sweep is offline (the enrichment worker is unreachable or missing its login)");
    if (opts.excludeKeys?.size && scanned === 0) reasons.push(`Fresh only is ON and ${opts.excludeKeys.size} previously-surfaced people are being excluded (uncheck it to see the full list again)`);
    if (scanned > 0) reasons.push(`${scanned} profiles were found but every one was ruled out by the search profile's hard disqualifiers or scored 0 fit; loosen the disqualifiers or the job location and run again`);
    warnings.unshift("empty_run: " + (reasons.length ? reasons.join("; ") : "no engine returned results"));

    // QUOTABLE STOP REASON: the warning above is engineer-grade and names vendors, so it
    // is NOT what the recruiter reads. Pick the single most actionable cause and pair a
    // stable code with a plain sentence the recruiter can act on or read down the phone
    // ("it stopped with SRC-CREDITS"), which points the engineer straight at the fix
    // without the recruiter ever seeing an engine name, a key or a query.
    // Ordered most-actionable first: the first match wins.
    // A dead Serper is no longer, on its own, a run-ending event: DataForSEO is the
    // primary pass and covers the volume. So SRC-CREDITS is reserved for the primary
    // failing, or for Serper failing with no primary left standing behind it.
    stopReason =
      (!useDfs && engines.includes("dataforseo") && dataforseoSearchConfigured()) ||
      (!useSerper && engines.includes("serper") && serperSearchConfigured() && !useDfs)
        ? { code: "SRC-CREDITS", message: "The wide web search stopped early: its account is out of credit, or its key was refused. Nobody could be pulled in. This one needs an admin, re-running it will not help." }
      : !useGoogle && !useSerper && !useDfs && engines.includes("serper") && !serperSearchConfigured() && !dataforseoSearchConfigured()
        ? { code: "SRC-NOKEY", message: "The wide web search is not switched on for this workspace, so the main source never ran. An admin has to turn it on in Setup." }
      : rapidDead || rapid404
        ? { code: "SRC-PEOPLE", message: "The people search refused every request, because its key or its address in Setup is wrong. An admin has to correct it; re-running will not help." }
      : engines.includes("koldinfo") && !useKold
        ? { code: "SRC-CONTACTDB", message: "The contact database is offline, so nobody could be looked up. An admin has to bring it back." }
      : opts.excludeKeys?.size && scanned === 0
        ? { code: "SRC-FRESHONLY", message: `Fresh only is ticked, and all ${opts.excludeKeys.size} people found had already been surfaced by an earlier search. Untick Fresh only and run again to see them.` }
      : scanned > 0
        ? { code: "SRC-FILTERED", message: `${scanned} people were found, but every one was ruled out by this search's must-haves or scored zero fit. Loosen the must-haves, or widen the location, and run again.` }
      : !useSearx && engines.includes("searx")
        ? { code: "SRC-FREEENGINE", message: "The free search engine did not answer and no other source returned anyone. Worth another run in a few minutes." }
      : { code: "SRC-NONE", message: "No search source returned anyone for this profile. Try a broader job title or a wider location." };
    // The engineer-facing specifics ride along separately, never in the sentence above.
    stopReason.detail = reasons.length ? reasons.join("; ") : "no engine returned results";
  }

  // SUCCESSFUL-RUN CLEANUP: per-query engine failures emit one line per company/page,
  // which turns into a wall of "rapidapi(...) 429" noise under the results table. Once
  // candidates came back, collapse them into a single short note; the raw per-query
  // list only matters on an empty run, where the diagnosis above consumes it.
  if (candidates.length) {
    const perQuery = /^(rapidapi|scraper|google|searx|serper|dataforseo|kolddb)\(/;
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

  return { candidates, warnings, scanned, stopReason, usage: { rapidapi: rapidUsed, serper: serperUsed, google: googleUsed, dataforseo: dfsUsed } };
}
