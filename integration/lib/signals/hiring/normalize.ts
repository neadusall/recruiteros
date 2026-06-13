/**
 * RecruitersOS · Hiring Engine
 * Entity normalization — the single join key shared by every source.
 *
 * Cross-source suppression only works if "Stripe, Inc." (an Indeed company name) and
 * "stripe" (a Greenhouse board slug) collapse to the SAME key. If each connector invents
 * its own anchor, the suppress layer silently leaks duplicates — the exact failure the
 * user wants to avoid. So this module is the ONE place a company (or a role) is reduced to
 * a canonical key, and both the coverage writer (free sources) and the reader (Indeed and
 * any other gated source) must run through it.
 *
 * Pure + deterministic: no network, no clock, no randomness — safe to call anywhere.
 */

/* ------------------------------------------------------------------ */
/* Company name → canonical anchor                                     */
/* ------------------------------------------------------------------ */

/**
 * Legal suffixes and corporate boilerplate that distinguish nothing. Stripped so
 * "Acme", "Acme Inc", "Acme Inc.", and "Acme Corporation" share one anchor.
 *
 * Deliberately conservative: descriptive words that DO distinguish companies
 * ("Labs", "Group", "Studios") are kept, because dropping them would merge distinct
 * firms and suppress real net-new coverage.
 */
const LEGAL_SUFFIXES =
  /\b(incorporated|inc|llc|l\.?l\.?c|ltd|limited|gmbh|corporation|corp|company|co|plc|llp|lp|sa|s\.?a|ag|nv|bv|oy|ab|as|pty|kk|k\.?k|srl|sas|sl)\b/gi;

/**
 * Reduce a company name to a canonical anchor: lowercase, strip legal suffixes and the
 * "the" article, drop everything but [a-z0-9], collapse to a single token.
 *
 *   "Stripe, Inc."        → "stripe"
 *   "Acme Corporation"    → "acme"
 *   "The Browser Company" → "browser"   (article + "company" suffix removed)
 *   "stripe" (slug)       → "stripe"    (idempotent for already-clean slugs)
 */
export function companyAnchor(name: string | undefined | null): string {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,]/g, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\bthe\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Domain → registrable root                                           */
/* ------------------------------------------------------------------ */

/** Two-label public suffixes we special-case so "acme.co.uk" → "acme", not "co". */
const MULTI_LABEL_TLDS = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "co.nz", "co.za", "com.au",
  "com.br", "com.mx", "com.sg", "co.in", "co.il", "com.tr",
]);

/**
 * The registrable root of a domain — the strongest possible company key when present.
 *
 *   "https://careers.stripe.com/jobs" → "stripe"
 *   "www.acme.co.uk"                  → "acme"
 *   "jobs.lever.co/acme"              → "lever"   (caller should prefer the name anchor
 *                                                  for ATS-hosted domains; see companyKeys)
 */
export function domainRoot(domain: string | undefined | null): string {
  if (!domain) return "";
  let host = String(domain).trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  host = host.replace(/^www\./, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 1) return labels[0] ?? "";
  const lastTwo = labels.slice(-2).join(".");
  // For multi-label TLDs the registrable label is the third-from-last.
  const sldIndex = MULTI_LABEL_TLDS.has(lastTwo) ? labels.length - 3 : labels.length - 2;
  return labels[Math.max(0, sldIndex)] ?? "";
}

/** ATS / job-board hosts whose domain root is the VENDOR, not the hiring company. */
const ATS_HOSTS = new Set([
  "lever", "greenhouse", "ashbyhq", "workable", "smartrecruiters", "recruitee",
  "myworkdayjobs", "workday", "bamboohr", "jobvite", "indeed", "linkedin",
  "remotive", "remoteok", "ycombinator", "arbeitnow", "jobicy",
]);

/* ------------------------------------------------------------------ */
/* Company keys — what the coverage set is keyed on                    */
/* ------------------------------------------------------------------ */

/**
 * Every key that should identify a company in the coverage set. A candidate is "already
 * covered" if ANY of its keys intersects the set, so we record (and match on) both the
 * domain root and the name anchor — maximizing the catch rate across sources that expose
 * different identifiers.
 *
 * Keys are namespaced (`d:` domain, `n:` name) so a company name that happens to equal
 * another company's domain root can't cross-match by accident.
 */
export function companyKeys(input: {
  name?: string;
  domain?: string;
}): string[] {
  const keys: string[] = [];
  const root = domainRoot(input.domain);
  if (root && !ATS_HOSTS.has(root)) keys.push(`d:${root}`);
  const anchor = companyAnchor(input.name);
  if (anchor) keys.push(`n:${anchor}`);
  // Fall back to the name anchor derived from an ATS-hosted domain's path is the
  // caller's job (they have the slug); here we key on whatever name/domain we were given.
  return [...new Set(keys)];
}

/* ------------------------------------------------------------------ */
/* Role keys — for optional role-level dedupe/suppression              */
/* ------------------------------------------------------------------ */

const STOPWORDS = /\b(senior|sr|junior|jr|staff|principal|lead|i|ii|iii|iv|remote|contract|fulltime|full|time|part)\b/gi;

/** Normalize a role title to a comparable token (drops seniority noise + punctuation). */
export function normalizeTitle(title: string | undefined | null): string {
  if (!title) return "";
  return String(title)
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(STOPWORDS, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** Coarse location token for role-level matching ("New York, NY" → "newyork"). */
export function normalizeLocation(loc: string | undefined | null): string {
  if (!loc) return "";
  const s = String(loc).toLowerCase();
  if (/remote|anywhere|distributed/.test(s)) return "remote";
  return s.replace(/,.*$/, "").replace(/[^a-z0-9]+/g, "").trim();
}

/**
 * A role-level key: same company + same normalized title + same coarse location is "the
 * same job", even across sources. Used only when suppress runs at role granularity.
 */
export function roleKey(input: {
  name?: string;
  domain?: string;
  title?: string;
  location?: string;
}): string {
  const company = companyKeys(input)[0] ?? `n:${companyAnchor(input.name)}`;
  return `r:${company}|${normalizeTitle(input.title)}|${normalizeLocation(input.location)}`;
}
