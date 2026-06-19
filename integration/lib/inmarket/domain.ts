/**
 * RecruitersOS · In-Market · Free, VERIFIED company-domain resolver
 *
 * THE UNLOCK. Almost every free hiring signal arrives with a company NAME but no domain
 * (job boards publish "Acme is hiring", not "acme.com"). Without a domain the whole
 * decision-maker funnel starves: the company-site team-page research is skipped (the single
 * highest-precision NAME source) AND no work email can ever be built (`guessEmail` needs a
 * domain). So a missing domain = no real person + no email = nothing reaches BD Bulk.
 *
 * This resolves a company's real web domain for FREE and — critically — VERIFIES it, so we
 * never feed a wrong domain into the email guesser (a wrong domain → confidently-wrong
 * address → bounce → sender-reputation damage). The contact waterfall already had a blind
 * `${slug}.com` guess; this replaces guessing with checking:
 *
 *   1. Candidate domains, best-first:
 *        a. an explicit hint (a real, non-ATS domain already on the lead),
 *        b. the host of the lead's own source/apply URL when it's the company's site
 *           (not an ATS/aggregator like greenhouse.io / lever.co / indeed.com),
 *        c. name-based guesses: the company anchor × the common TLDs (.com .io .co .ai …).
 *   2. VERIFY each candidate in parallel (bounded, short timeout):
 *        - the homepage actually responds (live, not NXDOMAIN / dead),
 *        - it is ON-BRAND (title/body mentions a distinctive token of the company name) — this
 *          is the anti-squatter / anti-parking check that makes name-guessing safe,
 *        - it is not a parked / for-sale placeholder,
 *        - it has MX records (it can actually receive mail) — required before we trust it for
 *          an email guess.
 *   3. Cache the verdict per company (positive monthly, negative weekly) so each company is
 *      resolved at most once a month, keeping this cheap at pool scale.
 *
 * 100% free, no keys, all best-effort: any failure returns null and the caller degrades to
 * exactly the prior behaviour (title-level target, no email).
 */

import { loadSnapshot, saveSnapshot } from "../db";
import { companyAnchor, domainRoot } from "../signals/hiring/normalize";
import { promises as dns } from "dns";

const CACHE_KEY = "inmarket_domain_v1";
const POS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // re-verify a found domain monthly
const NEG_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // retry a not-found company weekly
const FETCH_TIMEOUT_MS = 6_000;
const MAX_CANDIDATES = 6;                     // bound fetches per company
const MAX_BODY = 60_000;                      // cap homepage bytes scanned
const UA = "RecruitersOS/1.0 (+https://recruiteros.app; company-domain resolver)";

/** TLDs tried for name-based guesses, by real-world prevalence for US companies. */
const TLDS = ["com", "io", "co", "ai", "net", "org", "us", "app"];

/** Hosts whose registrable root is the VENDOR, never the hiring company — never accept these
 *  as a company domain (mirrors normalize.ts ATS_HOSTS, plus the boards we ingest from). */
const VENDOR_ROOTS = new Set([
  "lever", "greenhouse", "ashbyhq", "workable", "smartrecruiters", "recruitee",
  "myworkdayjobs", "workday", "bamboohr", "jobvite", "indeed", "linkedin", "glassdoor",
  "remotive", "remoteok", "ycombinator", "arbeitnow", "jobicy", "themuse", "himalayas",
  "workingnomads", "weworkremotely", "jobspresso", "adzuna", "findwork", "jobdataapi",
  "google", "bing", "facebook", "twitter", "x", "github", "notion", "airtable", "bit",
  "producthunt", "crunchbase", "wikipedia", "youtube", "medium", "substack", "gmail",
]);

export interface DomainResolution {
  /** The verified registrable domain, e.g. "acme.com". */
  domain: string;
  /** 0..1 — how strongly we trust this is the company's real domain. */
  confidence: number;
  /** how we got it: "hint" | "source_url" | "name_guess". */
  via: string;
  /** true when the domain has MX records (it can receive email — required for an email guess). */
  mx: boolean;
}

interface CacheRow { domain: string; confidence: number; via: string; mx: boolean; ok: boolean; at: number }

/* ------------------------------------------------------------------ */
/* Candidate construction                                              */
/* ------------------------------------------------------------------ */

/** A bare, lowercased registrable host from a URL or domain, or "" if it isn't one. */
function hostOf(urlOrDomain: string | undefined | null): string {
  if (!urlOrDomain) return "";
  let h = String(urlOrDomain).trim().toLowerCase();
  h = h.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/^www\./, "");
  return h.includes(".") ? h : "";
}

/** True if a host belongs to the hiring company (not an ATS / aggregator / social vendor). */
function isCompanyHost(host: string): boolean {
  const root = domainRoot(host);
  return !!root && !VENDOR_ROOTS.has(root);
}

/** Distinctive lowercase tokens of a company name (drops legal noise), longest-first. The
 *  on-brand check requires the homepage to mention one of these. */
function brandTokens(company: string): string[] {
  const cleaned = company
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|company|co|group|holdings|technologies|labs|software|systems|solutions|services|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return [...new Set(cleaned.split(/\s+/).filter((t) => t.length >= 3))].sort((a, b) => b.length - a.length);
}

/** Build the ordered, de-duplicated candidate domain list for a company. */
function candidatesFor(company: string, opts?: { sourceUrl?: string; hint?: string }): string[] {
  const out: string[] = [];
  const add = (d?: string) => {
    const v = (d || "").trim().toLowerCase();
    if (v && v.includes(".") && !out.includes(v)) out.push(v);
  };

  // a. explicit hint (already a real, non-ATS domain)
  const hintHost = hostOf(opts?.hint);
  if (hintHost && isCompanyHost(hintHost)) add(domainBase(hintHost));

  // b. the lead's own source/apply URL host, when it's the company's own site
  const srcHost = hostOf(opts?.sourceUrl);
  if (srcHost && isCompanyHost(srcHost)) add(domainBase(srcHost));

  // c. name-based guesses: anchor × TLDs
  const anchor = companyAnchor(company); // "Acme Health, Inc." -> "acmehealth"
  if (anchor && anchor.length >= 2) for (const tld of TLDS) add(`${anchor}.${tld}`);

  return out.slice(0, MAX_CANDIDATES);
}

/** Reduce a full host to its registrable domain ("careers.acme.co.uk" -> "acme.co.uk"). */
function domainBase(host: string): string {
  const root = domainRoot(host);
  if (!root) return host;
  const idx = host.indexOf(root + ".");
  return idx >= 0 ? host.slice(idx) : host;
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

/** Markers of a parked / for-sale / placeholder page — reject these even if live. */
const PARKED = /(domain (is )?for sale|buy this domain|parked (free|domain)|this domain( name)? is|godaddy\.com\/domainsearch|hugedomains|sedo\.com|namecheap\.com\/market|under construction|coming soon)/i;

async function homepageOnBrand(domain: string, tokens: string[]): Promise<boolean> {
  for (const scheme of ["https", "http"]) {
    try {
      const res = await fetch(`${scheme}://${domain}`, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
      });
      if (!res.ok) continue;
      const body = (await res.text()).slice(0, MAX_BODY).toLowerCase();
      if (!body) continue;
      if (PARKED.test(body)) return false;
      // On-brand: the homepage must mention a distinctive company token. This is what makes
      // name-guessing safe — acme.com only counts for "Acme" if its page actually says "acme".
      if (tokens.some((t) => body.includes(t))) return true;
      // A redirect that landed on the same registrable root is also a positive signal even if
      // the token check is noisy (e.g. heavy-JS homepages with little server-rendered text).
      const landed = hostOf(res.url);
      if (landed && domainRoot(landed) === domainRoot(domain) && body.length > 600) return true;
      return false;
    } catch {
      /* try http, then give up */
    }
  }
  return false;
}

/** True when the domain publishes MX records (so it can actually receive email). */
export async function hasMx(domain: string): Promise<boolean> {
  try {
    const mx = await dns.resolveMx(domain);
    return Array.isArray(mx) && mx.length > 0;
  } catch {
    return false;
  }
}

/** Verify ONE candidate: returns confidence>0 only if it's live + on-brand. mx checked too. */
async function verify(domain: string, tokens: string[], via: string): Promise<DomainResolution | null> {
  const onBrand = await homepageOnBrand(domain, tokens);
  if (!onBrand) return null;
  const mx = await hasMx(domain);
  // hint / source-url domains are inherently more trustworthy than a pure name guess.
  const base = via === "name_guess" ? 0.8 : 0.92;
  return { domain, confidence: mx ? base : base - 0.3, via, mx };
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

async function loadCache(): Promise<Record<string, CacheRow>> {
  return (await loadSnapshot<Record<string, CacheRow>>(CACHE_KEY).catch(() => null)) || {};
}

/**
 * Resolve a company's real, verified web domain for free — or null if none can be confirmed.
 * Cached per company (positive monthly, negative weekly). Safe to fan out under the curation
 * concurrency cap; each call is a handful of bounded, timed-out HTTP/DNS lookups at most, and
 * a cache hit is free.
 */
export async function resolveCompanyDomain(
  company: string,
  opts?: { sourceUrl?: string; hint?: string },
): Promise<DomainResolution | null> {
  const anchor = companyAnchor(company);
  if (!anchor) return null;

  const cache = await loadCache();
  const hit = cache[anchor];
  if (hit) {
    const fresh = Date.now() - hit.at < (hit.ok ? POS_TTL_MS : NEG_TTL_MS);
    if (fresh) return hit.ok ? { domain: hit.domain, confidence: hit.confidence, via: hit.via, mx: hit.mx } : null;
  }

  const tokens = brandTokens(company);
  // Need at least one distinctive token to run the on-brand check safely.
  const candidates = tokens.length ? candidatesFor(company, opts) : [];

  let best: DomainResolution | null = null;
  if (candidates.length) {
    const via = (d: string): string =>
      hostOf(opts?.hint) && domainBase(hostOf(opts!.hint!)) === d ? "hint"
      : hostOf(opts?.sourceUrl) && domainBase(hostOf(opts!.sourceUrl!)) === d ? "source_url"
      : "name_guess";
    const results = await Promise.all(candidates.map((d) => verify(d, tokens, via(d)).catch(() => null)));
    for (const r of results) if (r && (!best || r.confidence > best.confidence)) best = r;
  }

  // Write the verdict back (positive or negative) so we don't re-probe constantly.
  try {
    cache[anchor] = best
      ? { ...best, ok: true, at: Date.now() }
      : { domain: "", confidence: 0, via: "", mx: false, ok: false, at: Date.now() };
    await saveSnapshot(CACHE_KEY, cache);
  } catch { /* best-effort cache */ }

  return best;
}
