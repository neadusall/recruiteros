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
import { REMOTE_PHRASES, nationalGeoTargets } from "./remoteMode";

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

/** How many PROOF groups each breadth runs (see the precision block in generateQueries).
 *  Kept well under the title fan-out: proof queries are narrow by design, so their job is
 *  to bring back a smaller, better list, not to dominate the run's spend. */
const PROOF_GROUPS: Record<SearchBreadth, number> = { focused: 1, balanced: 2, wide: 4 };

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

/**
 * The wordings profiles use for one target geo: as typed + metro aliases.
 *
 * `regional` gates the WIDENING aliases. METRO_SYNONYMS maps a city to a multi-county or
 * even multi-state region ("Miami" -> "South Florida", "Oakland" -> "San Francisco Bay
 * Area"), and "Greater <City> Area" does the same informally — useful when the recruiter
 * asked for a broad radius, actively wrong on a tight one, where they pulled the search
 * far outside the miles that were requested. On a tight radius we still search the
 * neighbouring towns, but by NAME (pinIcpLocation supplies the real in-radius list)
 * rather than by a region label that has no boundary.
 */
export function geoVariants(geo: string, regional = true): string[] {
  const city = (geo.split(",")[0] || "").trim();
  const out = [geo];
  if (!regional) return out;
  for (const syn of METRO_SYNONYMS[city.toLowerCase()] || []) out.push(syn);
  if (city && !/greater|area|metro/i.test(geo)) out.push(`Greater ${city} Area`);
  return out.slice(0, 4);
}

/**
 * Below this radius, region-wide geo aliases and the geo-free "deep pass" are switched
 * off. 50 miles is the dropdown step at which a recruiter is plainly asking for a metro
 * rather than a town, which is exactly when "Greater X Area" starts describing the area
 * they meant instead of overshooting it.
 */
const REGIONAL_ALIAS_MIN_MI = 50;

/**
 * Build the search set. `titleCap` / `geoCap` keep X-ray strings short enough that
 * Google actually honors them; `breadth` decides how many title chunks fan out.
 */
export function generateQueries(
  icp: CandidateICP,
  opts: {
    titleCap?: number;
    geoCap?: number;
    breadth?: SearchBreadth;
    radiusMi?: number;
    /** Remote role: search the whole country, and target remote wording explicitly. */
    remote?: boolean;
    /** PRECISION PASS: ready X-ray fragments of proof evidence, strongest first, from
     *  buildProofPlan (lib/sourcing/proofPlan). Each looks like
     *  ("CPA" OR "ASC 740" OR "tax provision"). When present, the block below pairs the
     *  lead titles with each fragment so the ENGINE filters on qualification instead of
     *  us paying to filter a title-only list afterwards. Omitted = historical behavior. */
    proofGroups?: string[];
  } = {},
): SourcingQuery[] {
  const titleCap = opts.titleCap ?? 4;
  const geoCap = opts.geoCap ?? 6;
  const breadth = opts.breadth ?? "balanced";
  if (opts.remote) return remoteQueries(icp, titleCap, breadth);
  // No radius picked at all ("Exact", or a caller that does not know) leaves the historical
  // wide behavior alone; only an explicitly TIGHT radius turns the regional widening off.
  const radiusMi = opts.radiusMi ?? 0;
  const regionalAliases = radiusMi === 0 || radiusMi >= REGIONAL_ALIAS_MIN_MI;

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
    const geoVar = orGroup(geoVariants(geo, regionalAliases), 4);
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

  // 3.5) PRECISION PASS: lead titles × proof evidence × geo.
  //
  //    This is the block that answers "find people who can actually DO the job" rather
  //    than "find people whose title contains the words". A boolean like
  //      site:linkedin.com/in ("Senior Accountant" OR "Tax Accountant")
  //        ("CPA" OR "ASC 740" OR "tax provision") ("New Jersey" OR "Greater New York Area")
  //    makes the search engine itself do the qualifying, for the same per-search price as
  //    the broad query above. Every row it returns already carries evidence, so the same
  //    spend buys a shortlist instead of a longlist.
  //
  //    Deliberately narrow in scope: LEAD title chunk only (the closest-matching titles),
  //    because pairing every title chunk with every proof group multiplies the run past
  //    what its budget should carry, and the marginal query is always weaker than the one
  //    before it. Ordering matters too: these are pushed BEFORE the wide geo-free pass so
  //    that a run truncated by a per-run budget keeps its best-qualified searches.
  const proofGroups = (opts.proofGroups || []).slice(0, PROOF_GROUPS[breadth]);
  if (proofGroups.length && titleGroup) {
    for (const geo of icp.geos.slice(0, geoCap)) {
      const geoVar = orGroup(geoVariants(geo, regionalAliases), 4);
      for (const proof of proofGroups) {
        const xray = [`site:linkedin.com/in`, titleGroup, proof, geoVar].filter(Boolean).join(" ");
        // The label quotes the first term in the group, so the recruiter's provenance
        // reads "Senior Accountant in New Jersey with CPA" rather than a boolean.
        const firstTerm = (proof.match(/"([^"]+)"/) || [])[1] || "evidence";
        out.push({
          group: `qualified: ${firstTerm}`,
          label: `${titleChunks[0][0] || leadTitle(icp)} in ${geo} with ${firstTerm}`,
          xray,
          googleUrl: googleUrl(xray),
          linkedinUrl: linkedinUrl(`${titleChunks[0][0] || leadTitle(icp)} ${firstTerm} ${geo}`),
          keyword: `${titleChunks[0][0] || leadTitle(icp)} ${firstTerm} ${geo}`.trim(),
          titleTerm: titleChunks[0][0] || undefined,
        });
      }
    }
  }

  // 4) WIDE ONLY: geo-free searches (title chunk × industry, no location term).
  //    Snippets often omit the location wording even for locals, so the geo term in
  //    the Boolean silently drops them; this pass catches those. It stays honest
  //    because discovery parses each row's stated location from the snippet and the
  //    strict-location filter still drops clear non-locals (unknowns are kept, as
  //    everywhere else).
  //    Skipped on a TIGHT radius: correctness is fine either way (the distance filter
  //    catches the strays), but a nationwide pass whose results are then almost entirely
  //    discarded spends search credits to find people the recruiter cannot hire.
  if (breadth === "wide" && regionalAliases) {
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

/* ------------------------------------------------------------------ */
/* Remote roles: the national search set                               */
/* ------------------------------------------------------------------ */

/**
 * How many title chunks ride the metro rota.
 *
 * The rota is the expensive axis (chunks × metros), so only the closest-matching title
 * groups run against every metro; the rest still run nationwide in the geo-free passes
 * below, which cost one query each. Keeps a balanced remote run in the same query budget
 * as a balanced local one while covering the whole country.
 */
const METRO_ROTA_CHUNKS: Record<SearchBreadth, number> = { focused: 1, balanced: 2, wide: 3 };

/**
 * The search set for a REMOTE role: no radius, no pinned metro, the whole US.
 *
 * Four passes, cheapest signal first. Nothing here filters on location — a remote run
 * drops nobody for where they live — so every pass is purely about reaching people the
 * others would miss:
 *
 *   1. STATED REMOTE. People whose profile already says Remote / Work From Home. The
 *      strongest rows in a remote search and the only pass that targets them directly.
 *   2. NATIONWIDE BY INDUSTRY. Title × industry with no location term at all. Catches
 *      everyone whose snippet simply never mentions where they are, which on a geo-free
 *      search is most people.
 *   3. TARGET COMPANIES. The poaching searches, minus the geo term the local builder
 *      staples on (a remote role does not care that the VP of Ops at a competitor lives
 *      in Ohio).
 *   4. THE METRO ROTA. The same title Boolean fanned across the country's largest
 *      professional markets. This is what turns "the first page of a national query"
 *      into real national coverage — see remoteMode.ts for why one query is not enough.
 */
function remoteQueries(icp: CandidateICP, titleCap: number, breadth: SearchBreadth): SourcingQuery[] {
  const allTitles = icp.titles.length ? icp.titles : [leadTitle(icp)];
  const titleChunks = chunkList(allTitles, titleCap).slice(0, TITLE_CHUNKS[breadth]);
  const titleGroups = titleChunks.map((c) => orGroup(c, titleCap));
  const titleGroup = titleGroups[0];
  const industryGroup = orGroup(icp.industries, 4);
  const remoteGroup = orGroup(REMOTE_PHRASES, 4);
  const out: SourcingQuery[] = [];
  const leadOf = (ci: number) => titleChunks[ci][0] || leadTitle(icp);

  // 1) People who state they work remotely. Industry is deliberately LEFT OUT: the
  //    remote OR-group is already several terms wide, and every extra AND against a
  //    two-line snippet costs more recall than the precision is worth here.
  titleGroups.forEach((tg, ci) => {
    const xray = [`site:linkedin.com/in`, tg, remoteGroup].filter(Boolean).join(" ");
    out.push({
      group: "remote: works remotely",
      label: `${leadOf(ci)} working remotely`,
      xray,
      googleUrl: googleUrl(xray),
      linkedinUrl: linkedinUrl(`${leadOf(ci)} remote`),
      keyword: `${leadOf(ci)} remote`.trim(),
      titleTerm: leadOf(ci),
    });
  });

  // 2) Nationwide, no location term.
  titleGroups.forEach((tg, ci) => {
    const xray = [`site:linkedin.com/in`, tg, industryGroup].filter(Boolean).join(" ");
    out.push({
      group: "nationwide: industry",
      label: `${leadOf(ci)} across the US`,
      xray,
      googleUrl: googleUrl(xray),
      linkedinUrl: linkedinUrl(`${leadOf(ci)} ${icp.industries.slice(0, 2).join(" ")}`.trim()),
      keyword: `${leadOf(ci)} ${icp.industries.slice(0, 2).join(" ")}`.trim(),
      titleTerm: leadOf(ci),
    });
  });

  // 3) Target companies, nationwide.
  for (const company of icp.targetCompanies) {
    const xray = [`site:linkedin.com/in`, titleGroup, q(company)].filter(Boolean).join(" ");
    out.push({
      group: company,
      label: `${leadTitle(icp)} @ ${company}`,
      xray,
      googleUrl: googleUrl(xray),
      linkedinUrl: linkedinUrl(`${company} ${leadTitle(icp)}`),
      keyword: `${leadTitle(icp)} ${company}`.trim(),
      titleTerm: leadTitle(icp),
    });
  }

  // 4) The metro rota: national coverage, one market at a time.
  const rotaChunks = titleGroups.slice(0, METRO_ROTA_CHUNKS[breadth]);
  for (const metro of nationalGeoTargets(breadth)) {
    const geoVar = orGroup(geoVariants(metro, true), 4);
    rotaChunks.forEach((tg, ci) => {
      const xray = [`site:linkedin.com/in`, tg, industryGroup, geoVar].filter(Boolean).join(" ");
      out.push({
        group: `nationwide: ${metro}`,
        label: `${leadOf(ci)} in ${metro}`,
        xray,
        googleUrl: googleUrl(xray),
        linkedinUrl: linkedinUrl(`${leadOf(ci)} ${metro}`),
        keyword: `${leadOf(ci)} ${metro}`.trim(),
        titleTerm: leadOf(ci),
        geoLocation: metro,
      });
    });
  }

  return out;
}
