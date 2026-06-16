/**
 * RecruitersOS · JD Sourcing
 * Turn a CandidateICP into runnable searches.
 *
 * Two flavors per theme:
 *  - a Google X-ray Boolean string over linkedin.com/in (the most portable way to
 *    surface public profiles), wrapped in a ready Google URL, and
 *  - a LinkedIn People Search URL (keyword-based) that feeds importFromLinkedInSearch.
 *
 * We emit one query per target company (the highest-signal poaching searches) plus a
 * handful of company-agnostic "broad" queries combining titles × industries × geos so
 * coverage isn't capped by the named-company list. Pure function — no I/O.
 */

import type { CandidateICP, SourcingQuery } from "./types";

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

/**
 * Build the search set. `titleCap` / `geoCap` keep X-ray strings short enough that
 * Google actually honors them.
 */
export function generateQueries(icp: CandidateICP, opts: { titleCap?: number; geoCap?: number } = {}): SourcingQuery[] {
  const titleCap = opts.titleCap ?? 4;
  const geoCap = opts.geoCap ?? 6;

  const titleGroup = orGroup(icp.titles.length ? icp.titles : [leadTitle(icp)], titleCap);
  const geoGroup = orGroup(icp.geos, geoCap);
  const industryGroup = orGroup(icp.industries, 4);
  const out: SourcingQuery[] = [];

  // 1) One high-signal poaching search per named target company.
  for (const company of icp.targetCompanies) {
    const xray = [`site:linkedin.com/in`, titleGroup, q(company), geoGroup].filter(Boolean).join(" ");
    out.push({
      group: company,
      label: `${leadTitle(icp)} @ ${company}`,
      xray,
      googleUrl: googleUrl(xray),
      linkedinUrl: linkedinUrl(`${company} ${leadTitle(icp)}`),
      keyword: `${leadTitle(icp)} ${company}`.trim(),
    });
  }

  // 2) Company-agnostic broad searches: titles × industry × geo, so coverage isn't
  //    bounded by the named-company list (this is what lets a run reach the thousands).
  if (industryGroup) {
    const xray = [`site:linkedin.com/in`, titleGroup, industryGroup, geoGroup].filter(Boolean).join(" ");
    out.push({
      group: "broad: industry",
      label: `${leadTitle(icp)} across target industries`,
      xray,
      googleUrl: googleUrl(xray),
      linkedinUrl: linkedinUrl(`${leadTitle(icp)} ${icp.industries.slice(0, 2).join(" ")}`),
      keyword: `${leadTitle(icp)} ${icp.industries.slice(0, 2).join(" ")}`.trim(),
    });
  }

  // 3) One broad search per geo metro (titles × single metro) for geographic depth.
  for (const geo of icp.geos.slice(0, geoCap)) {
    const xray = [`site:linkedin.com/in`, titleGroup, industryGroup, q(geo)].filter(Boolean).join(" ");
    out.push({
      group: `broad: ${geo}`,
      label: `${leadTitle(icp)} in ${geo}`,
      xray,
      googleUrl: googleUrl(xray),
      linkedinUrl: linkedinUrl(`${leadTitle(icp)} ${geo}`),
      keyword: `${leadTitle(icp)} ${geo}`.trim(),
    });
  }

  return out;
}
