/**
 * RecruitersOS · SERP query rewrite for DataForSEO's advanced-operator surcharge
 *
 * DataForSEO bills 5x for any Google task whose keyword contains an advanced operator
 * (site:, inurl:, intitle:, filetype: — stated in their docs, and confirmed by billing on
 * this account: a generic query bills $0.0006 queued / $0.002 live, the same query with
 * `site:` bills $0.003 / $0.01). Every x-ray this app writes carries `site:linkedin.com/in`,
 * so the surcharge lands on ~100% of our volume.
 *
 * The dodge, measured 2026-08-14 on an 8-query naming battery: replace the `site:` operator
 * with the same domain-path as a QUOTED PHRASE — Google matches quoted strings against URLs
 * too, so `"VP of Engineering" "Datadog" "linkedin.com/in"` returns the same profile rows
 * (8/8 queries returned linkedin.com/in URLs, 7/8 right-company hits, identical titles) at
 * 1/5th the bill. A quoted phrase is a HINT, not a filter, so callers that require the
 * domain must still drop non-matching rows — `matchesSitePrefixes` is that check. (Both
 * current callers already do: discovery's mapGoogleItem hard-requires linkedin.com/in, and
 * webSearch post-filters with this helper.)
 *
 * Pure module, no I/O — regression-tested in scripts/test-serp-rewrite.mts.
 */

export interface SiteRewrite {
  /** The query to actually send to DataForSEO. */
  query: string;
  /** Domain-path prefixes the original `site:` operators demanded, e.g. ["linkedin.com/in"]. */
  sitePrefixes: string[];
  /** True when a rewrite happened (false = the query had no site: operator). */
  changed: boolean;
}

const SITE_RE = /(^|\s)site:([^\s"']+)/gi;

/** Strip protocol/www noise so "https://www.linkedin.com/in" and "linkedin.com/in" compare equal. */
function normalizeSite(s: string): string {
  return s
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

/**
 * Replace every `site:X` operator with `"X"` (quoted phrase) and report the prefixes so the
 * caller can post-filter result URLs. Queries without `site:` come back untouched.
 */
export function rewriteSiteOperators(query: string): SiteRewrite {
  const sitePrefixes: string[] = [];
  const rewritten = String(query || "").replace(SITE_RE, (_m, lead: string, site: string) => {
    const norm = normalizeSite(site);
    if (norm && !sitePrefixes.includes(norm)) sitePrefixes.push(norm);
    return norm ? `${lead}"${norm}"` : lead;
  });
  return {
    query: rewritten.replace(/\s{2,}/g, " ").trim(),
    sitePrefixes,
    changed: sitePrefixes.length > 0,
  };
}

/**
 * Does this result URL satisfy one of the original `site:` restrictions? Uses substring
 * matching on the normalized URL so country subdomains pass the way Google's own site:
 * treats them (uk.linkedin.com/in/... satisfies site:linkedin.com/in).
 */
export function matchesSitePrefixes(url: string, sitePrefixes: string[]): boolean {
  if (!sitePrefixes.length) return true;
  const norm = normalizeSite(String(url || ""));
  if (!norm) return false;
  return sitePrefixes.some((p) => norm.includes(p));
}
