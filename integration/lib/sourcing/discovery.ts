/**
 * RecruiterOS · JD Sourcing
 * Discovery orchestrator — turn the JD-derived queries into a ranked candidate list.
 *
 * This is the part that "goes out and finds the people." It hands each Boolean /
 * keyword query to a configured engine and accumulates results, deduped and scored,
 * until it hits the cap or runs out of queries.
 *
 * Engines (cheapest-first, matching the project's cost discipline):
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

/* ------------------------------------------------------------------ */
/* RapidAPI people-search provider (configurable)                      */
/* ------------------------------------------------------------------ */

const RAPIDAPI_KEY = () => process.env.RAPIDAPI_KEY ?? "";
const PS_HOST = () => process.env.RAPIDAPI_PEOPLE_SEARCH_HOST ?? "";
const PS_PATH = () => process.env.RAPIDAPI_PEOPLE_SEARCH_PATH ?? "/search/people"; // {query},{page} interpolated

export function rapidApiSearchConfigured(): boolean {
  return Boolean(RAPIDAPI_KEY() && PS_HOST());
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
  return {
    fullName,
    title: str(o.title) || str(o.job_title) || str(o.jobTitle) || str(o.position),
    headline: str(o.headline) || str(o.summary),
    company: str(o.company) || str(o.company_name) || str(o.companyName) || str(o.current_company),
    location: str(o.location) || str(o.geo) || str(o.city) || str(o.region),
    linkedinUrl: str(o.linkedin_url) || str(o.linkedinUrl) || str(o.profile_url) || str(o.profileUrl) || str(o.url),
    imageUrl: str(o.image) || str(o.photo) || str(o.profile_image) || str(o.imageUrl),
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

async function rapidApiPeopleSearch(query: string, page: number): Promise<CandidateRow[]> {
  const host = PS_HOST();
  const path = PS_PATH()
    .replace("{query}", encodeURIComponent(query))
    .replace("{page}", String(page));
  // Most listings accept the query as a param; if the path didn't interpolate it,
  // append it as ?query=. Harmless if the listing ignores the extra param.
  const url = `https://${host}${path}${path.includes("{") || path.includes("query=") ? "" : (path.includes("?") ? "&" : "?") + "query=" + encodeURIComponent(query) + "&page=" + page}`;
  const res = await fetch(url, {
    headers: { "X-RapidAPI-Key": RAPIDAPI_KEY(), "X-RapidAPI-Host": host, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`rapidapi ${host} ${res.status}`);
  const data = await res.json().catch(() => ({}));
  return extractList(data).map(mapRow).filter((r): r is CandidateRow => Boolean(r));
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
  const engines = opts.engines ?? (["rapidapi", "scraper"] as const);
  const warnings: string[] = [];

  const useRapid = engines.includes("rapidapi") && rapidApiSearchConfigured();
  const useScraper = engines.includes("scraper") && scraperConfigured();
  if (engines.includes("rapidapi") && !useRapid) {
    warnings.push("rapidapi_not_configured: set RAPIDAPI_KEY + RAPIDAPI_PEOPLE_SEARCH_HOST to enable scale discovery");
  }
  if (!useRapid && !useScraper) {
    warnings.push("no_discovery_engine: nothing configured to find profiles — list will be empty");
    return { candidates: [], warnings, scanned: 0 };
  }

  const byKey = new Map<string, CandidateRow>();
  let scanned = 0;

  // Per-query budget so one big company doesn't starve the others.
  const perQuery = Math.max(20, Math.ceil(cap / Math.max(1, queries.length)) + 20);

  outer: for (const query of queries) {
    let collected = 0;

    if (useRapid) {
      for (let page = 1; page <= 10 && collected < perQuery; page++) {
        let rows: CandidateRow[] = [];
        try {
          rows = await rapidApiPeopleSearch(query.xray || query.label, page);
        } catch (err) {
          warnings.push(`rapidapi(${query.group} p${page}): ${(err as Error).message}`);
          break; // stop paging this query on error; move on
        }
        if (!rows.length) break; // exhausted
        for (const r of rows) {
          scanned++;
          r.sourceGroup = query.group;
          const sc = scoreCandidate(r, icp);
          r.fitScore = sc.fitScore; r.fitReasons = sc.fitReasons;
          if (r.fitScore < minFit) continue;
          const k = keyOf(r);
          const prev = byKey.get(k);
          if (!prev || r.fitScore > prev.fitScore) byKey.set(k, r);
          collected++;
          if (byKey.size >= cap) break outer;
        }
      }
    }

    if (useScraper && collected < perQuery) {
      try {
        const { profiles, warnings: w } = await scrapeSearchViaSidecar(query.linkedinUrl, Math.min(perQuery, 100));
        if (w?.length) warnings.push(...w.map((x) => `scraper(${query.group}): ${x}`));
        for (const p of profiles) {
          scanned++;
          const r: CandidateRow = {
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
          };
          const sc = scoreCandidate(r, icp);
          r.fitScore = sc.fitScore; r.fitReasons = sc.fitReasons;
          if (r.fitScore < minFit) continue;
          const k = keyOf(r);
          const prev = byKey.get(k);
          if (!prev || r.fitScore > prev.fitScore) byKey.set(k, r);
          if (byKey.size >= cap) break outer;
        }
      } catch (err) {
        warnings.push(`scraper(${query.group}): ${(err as Error).message}`);
      }
    }
  }

  const candidates = Array.from(byKey.values())
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, cap);

  return { candidates, warnings, scanned };
}
