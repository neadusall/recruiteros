/**
 * RecruitersOS · JD Sourcing
 * Turn a CandidateICP into runnable searches.
 *
 * Two flavors per theme:
 *  - a Google X-ray Boolean string over linkedin.com/in (the most portable way to
 *    surface public profiles), wrapped in a ready Google URL, and
 *  - a LinkedIn People Search URL (keyword-based) that feeds importFromLinkedInSearch.
 *
 * We emit one query per target company (the highest-signal poaching searches) plus
 * company-agnostic "broad" queries combining titles × industries × geos so coverage
 * isn't capped by the named-company list. Pure function — no I/O.
 *
 * BREADTH (the Sales-Navigator lesson, 2026-07-16): an X-ray query is an AND across
 * everything in it, matched against a ~2-line Google snippet, so each extra term
 * throttles recall hard. The LLM parse emits 10-20 title variants but a single
 * OR-group only carries `titleCap` of them — the rest used to be thrown away, which
 * is why runs returned dozens instead of hundreds. Now the titles are CHUNKED into
 * several OR-groups and the broad searches fan out one query per chunk × geo, so
 * every title variant actually runs. Wide mode adds geo-free chunks on top (the
 * post-search location filter keeps those honest — see locationFromSnippet in
 * discovery.ts). Quality is preserved because breadth only widens WHERE we look;
 * scoring/ranking still decides who surfaces first.
 */

import type { CandidateICP, SearchBreadth, SourcingQuery } from "./types";

/** Quote a phrase for Boolean search if it contains spaces. */
function q(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}

/** OR-join a capped set of phrases into a Boolean group: (a OR b OR c). */
function orGroup(items: string[], cap: number): string {
  const picked = items.filter(Boolean).slice(0, cap).map(q);
  return picked.length ? `(${picked.join(" OR ")})` : "";
}

function googleUrl(xray: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(xray)}`;
}

function linkedinUrl(keywords: string): string {
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}&origin=GLOBAL_SEARCH_HEADER`;
}

/** Lead title used for the (shorter) LinkedIn keyword box. */
function leadTitle(icp: CandidateICP): string {
  return icp.titles[0] || (icp.seniority === "vp" ? "VP Sales" : "Sales Director");
}

/** Split a list into consecutive chunks of `size` (last one may be shorter). */
function chunkList<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** How many title chunks each breadth runs (chunk = one titleCap-sized OR-group). */
const TITLE_CHUNKS: Record<SearchBreadth, number> = { focused: 1, balanced: 3, wide: 5 };

/**
 * Metro synonyms: LinkedIn profiles state metros in region wording ("Dallas-Fort
 * Worth Metroplex", "Greater Boston") far more often than the "City, ST" a recruiter
 * types, and an X-ray only matches the literal text in the snippet. A small alias
 * table for the big US metros (plus a generic "Greater <City> Area") widens each
 * per-geo search to the wordings profiles actually use.
 */
const METRO_SYNONYMS: Record<string, string[]> = {
  "new york": ["New York City Metropolitan Area", "Greater New York"],
  "dallas": ["Dallas-Fort Worth Metroplex", "DFW"],
  "fort worth": ["Dallas-Fort Worth Metroplex"],
  "san francisco": ["San Francisco Bay Area"],
  "oakland": ["San Francisco Bay Area"],
  "san jose": ["San Francisco Bay Area"],
  "los angeles": ["Greater Los Angeles Area"],
  "washington": ["Washington DC-Baltimore Area"],
  "minneapolis": ["Minneapolis-St. Paul", "Greater Minneapolis-St. Paul Area"],
  "miami": ["Miami-Fort Lauderdale Area", "South Florida"],
  "chicago": ["Greater Chicago Area", "Chicagoland"],
  "boston": ["Greater Boston"],
  "atlanta": ["Atlanta Metropolitan Area", "Greater Atlanta"],
  "seattle": ["Greater Seattle Area"],
  "houston": ["Greater Houston"],
  "phoenix": ["Greater Phoenix Area"],
  "denver": ["Denver Metropolitan Area"],
  "philadelphia": ["Greater Philadelphia"],
  "detroit": ["Detroit Metropolitan Area"],
  "salt lake": ["Salt Lake City Metropolitan Area"],
};

/** The wordings profiles use for one target geo: as typed + metro aliases. */
export function geoVariants(geo: string): string[] {
  const city = (geo.split(",")[0] || "").trim();
  const out = [geo];
  for (const syn of METRO_SYNONYMS[city.toLowerCase()] || []) out.push(syn);
  if (city && !/greater|area|metro/i.test(geo)) out.push(`Greater ${city} Area`);
  return out.slice(0, 4);
}

/**
 * Build the search set. `titleCap` / `geoCap` keep X-ray strings short enough that
 * Google actually honors them; `breadth` decides how many title chunks fan out.
 */
export function generateQueries(
  icp: CandidateICP,
  opts: { titleCap?: number; geoCap?: number; breadth?: SearchBreadth } = {},
): SourcingQuery[] {
  const titleCap = opts.titleCap ?? 4;
  const geoCap = opts.geoCap ?? 6;
  const breadth = opts.breadth ?? "balanced";

  const allTitles = icp.titles.length ? icp.titles : [leadTitle(icp)];
  const titleChunks = chunkList(allTitles, titleCap).slice(0, TITLE_CHUNKS[breadth]);
  const titleGroups = titleChunks.map((c) => orGroup(c, titleCap));
  const titleGroup = titleGroups[0]; // lead chunk: the closest matches, used by the tight searches
  const geoGroup = orGroup(icp.geos, geoCap);
  const industryGroup = orGroup(icp.industries, 4);
  const out: SourcingQuery[] = [];

  // 1) One high-signal poaching search per named target company.
  //    NOTE: the precise current_company filter needs a NUMERIC LinkedIn company id, which
  //    we don't have here (only the name). Until a name→id resolver runs, the company rides
  //    in the keyword. `titleTerm` carries the title alone so a resolver can later switch this
  //    query to structured mode (title in `name`, resolved id in current_company).
  // The primary geo rides in the KEYWORD too: paid keyword listings have no separate
  // geo filter until a numeric geo-id resolver exists, so without this every company
  // query searched title + company NATIONWIDE (the "locations across the board" bug).
  const geoHint = icp.geos[0] ? ` ${icp.geos[0]}` : "";
  for (const company of icp.targetCompanies) {
    const xray = [`site:linkedin.com/in`, titleGroup, q(company), geoGroup].filter(Boolean).join(" ");
    out.push({
      group: company,
      label: `${leadTitle(icp)} @ ${company}`,
      xray,
      googleUrl: googleUrl(xray),
      linkedinUrl: linkedinUrl(`${company} ${leadTitle(icp)}${geoHint}`),
      keyword: `${leadTitle(icp)} ${company}${geoHint}`.trim(),
      titleTerm: leadTitle(icp),
    });
  }

  // 2) Company-agnostic broad searches: titles × industry × geo, so coverage isn't
  //    bounded by the named-company list (this is what lets a run reach the thousands).
  //    One query per TITLE CHUNK, so every title variant from the parse actually runs.
  if (industryGroup) {
    titleGroups.forEach((tg, ci) => {
      const lead = titleChunks[ci][0] || leadTitle(icp);
      const xray = [`site:linkedin.com/in`, tg, industryGroup, geoGroup].filter(Boolean).join(" ");
      out.push({
        group: "broad: industry",
        label: `${lead} across target industries`,
        xray,
        googleUrl: googleUrl(xray),
        linkedinUrl: linkedinUrl(`${lead} ${icp.industries.slice(0, 2).join(" ")}${geoHint}`),
        keyword: `${lead} ${icp.industries.slice(0, 2).join(" ")}${geoHint}`.trim(),
      });
    });
  }

  // 3) Broad searches per geo metro (title chunk × single metro) for geographic depth.
  //    Each metro rides as an OR-group of the wordings profiles actually state
  //    ("Fair Lawn, NJ" OR "Greater Fair Lawn Area"), and every title chunk gets its
  //    own query — this fan-out is where a run grows from dozens to hundreds.
  //    geocode_location needs a NUMERIC LinkedIn geo id (e.g. 103644278), not a city name,
  //    so the metro stays in the keyword for now; a geo-id resolver can switch it later.
  for (const geo of icp.geos.slice(0, geoCap)) {
    const geoVar = orGroup(geoVariants(geo), 4);
    titleGroups.forEach((tg, ci) => {
      const lead = titleChunks[ci][0] || leadTitle(icp);
      const xray = [`site:linkedin.com/in`, tg, industryGroup, geoVar].filter(Boolean).join(" ");
      out.push({
        group: `broad: ${geo}`,
        label: `${lead} in ${geo}`,
        xray,
        googleUrl: googleUrl(xray),
        linkedinUrl: linkedinUrl(`${lead} ${geo}`),
        keyword: `${lead} ${geo}`.trim(),
      });
    });
  }

  // 4) WIDE ONLY: geo-free searches (title chunk × industry, no location term).
  //    Snippets often omit the location wording even for locals, so the geo term in
  //    the Boolean silently drops them; this pass catches those. It stays honest
  //    because discovery parses each row's stated location from the snippet and the
  //    strict-location filter still drops clear non-locals (unknowns are kept, as
  //    everywhere else).
  if (breadth === "wide") {
    titleGroups.forEach((tg, ci) => {
      const lead = titleChunks[ci][0] || leadTitle(icp);
      const xray = [`site:linkedin.com/in`, tg, industryGroup].filter(Boolean).join(" ");
      out.push({
        group: "broad: beyond location wording",
        label: `${lead} (deep pass)`,
        xray,
        googleUrl: googleUrl(xray),
        linkedinUrl: linkedinUrl(`${lead}${geoHint}`),
        keyword: `${lead}${geoHint}`.trim(),
      });
    });
  }

  return out;
}
