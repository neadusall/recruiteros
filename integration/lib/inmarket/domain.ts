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

import { loadSnapshot, debouncedSaver } from "../db";
import { companyAnchor, domainRoot } from "../signals/hiring/normalize";
import { promises as dns } from "dns";

// v2: abandon the v1 cache — it's full of NEGATIVE entries from the old homepage-scraping resolver
// (which sat at ~1%). Starting fresh lets Clearbit re-resolve every company at ~95% from the next
// curation pass instead of waiting 6h for each poisoned negative to expire.
const CACHE_KEY = "inmarket_domain_v2";
const POS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // re-verify a found domain monthly
const NEG_TTL_MS = 6 * 60 * 60 * 1000;       // retry a not-found company every 6h — short so the
                                             // looser (live + MX) acceptance reprocesses the backlog
                                             // of domain misses quickly instead of being stuck a week
const FETCH_TIMEOUT_MS = 6_000;
const MAX_CANDIDATES = 10;                    // bound fetches per company (verified in parallel, cached monthly)
const MAX_BODY = 60_000;                      // cap homepage bytes scanned
const MAX_CACHE = 60_000;                     // bound the persisted cache blob
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

/** Company name tokens in ORDER, legal noise dropped — the first is the most likely standalone brand
 *  ("Ramp Financial" → ["ramp","financial"]). Used so a multi-word company whose real domain is just its
 *  first word (ramp.com) is actually guessed, not only the concatenated anchor (rampfinancial.com). */
function orderedTokens(company: string): string[] {
  return company
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|company|co|group|holdings|technologies|labs|software|systems|solutions|services|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/** Build the ordered, de-duplicated candidate domain list for a company, best-first. Every candidate is
 *  still VERIFIED (on-brand / MX) before acceptance, so adding looser guesses can't produce a wrong
 *  domain — it only widens what we can CONFIRM. */
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

  // c. name-based guesses, most-likely first:
  const anchor = companyAnchor(company); // "Acme Health, Inc." -> "acmehealth"
  const first = orderedTokens(company)[0] || "";
  //   – the full anchor on the top TLDs,
  if (anchor && anchor.length >= 2) for (const tld of ["com", "io", "co", "ai"]) add(`${anchor}.${tld}`);
  //   – the FIRST brand token alone (the ramp.com case the anchor misses),
  if (first && first !== anchor && first.length >= 3) for (const tld of ["com", "io", "co"]) add(`${first}.${tld}`);
  //   – common startup prefix/suffix patterns,
  if (anchor && anchor.length >= 2) for (const p of [`get${anchor}.com`, `${anchor}hq.com`, `join${anchor}.com`, `try${anchor}.com`, `${anchor}app.com`]) add(p);
  //   – then the remaining anchor TLDs as a last resort.
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

/** What we could tell about a candidate domain's homepage: is it live, is it a parked/for-sale
 *  placeholder, and did it mention a distinctive company token (the strong on-brand signal)? */
interface HomeStatus { live: boolean; parked: boolean; onBrand: boolean }

async function homepageStatus(domain: string, tokens: string[]): Promise<HomeStatus> {
  const { egressFetch } = await import("../net/egress");
  for (const scheme of ["https", "http"]) {
    try {
      const res = await egressFetch(`${scheme}://${domain}`, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
      });
      if (!res.ok) continue;
      const body = (await res.text()).slice(0, MAX_BODY).toLowerCase();
      if (!body) continue;
      if (PARKED.test(body)) return { live: true, parked: true, onBrand: false };
      // On-brand: the homepage mentions a distinctive company token. This is the strong signal —
      // acme.com is confidently "Acme" if its page actually says "acme".
      if (tokens.some((t) => body.includes(t))) return { live: true, parked: false, onBrand: true };
      // A redirect that landed on the same registrable root is also strong even if the token check
      // is noisy (heavy-JS homepages with little server-rendered text).
      const landed = hostOf(res.url);
      if (landed && domainRoot(landed) === domainRoot(domain) && body.length > 600) return { live: true, parked: false, onBrand: true };
      // Live, real, non-parked site but no distinctive token surfaced (common for JS-rendered homepages).
      return { live: true, parked: false, onBrand: false };
    } catch {
      /* try http, then give up */
    }
  }
  return { live: false, parked: false, onBrand: false };
}

/**
 * MX status for a domain, distinguishing the three cases that MATTER for not wrongly suppressing
 * a good address:
 *   - "mx"    → publishes MX records (can receive mail) — a positive deliverability signal.
 *   - "none"  → the domain itself does not resolve at all (NXDOMAIN) — definitively dead mail.
 *   - "error" → uncertain: a transient DNS failure, OR no MX but the domain exists (many firms
 *               receive mail via an implicit A/AAAA record). We must NOT treat this as invalid,
 *               or one DNS hiccup permanently suppresses a real prospect.
 */
export async function mxStatus(domain: string): Promise<"mx" | "none" | "error"> {
  try {
    const mx = await dns.resolveMx(domain);
    if (Array.isArray(mx) && mx.length > 0) return "mx";
    return "error"; // empty answer without throwing — treat as uncertain, never as dead
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    // No MX records (ENOTFOUND/ENODATA on the MX query) doesn't prove the domain is dead — confirm
    // with an A/AAAA lookup. Only a true NXDOMAIN on the host itself is definitively undeliverable.
    if (code === "ENOTFOUND" || code === "ENODATA") {
      try { await dns.lookup(domain); return "error"; }          // domain exists, just no MX → uncertain
      catch (e2) { return (e2 as NodeJS.ErrnoException)?.code === "ENOTFOUND" ? "none" : "error"; }
    }
    return "error"; // ETIMEOUT / ESERVFAIL / etc. — transient, never suppress on these
  }
}

/** True when the domain publishes MX records (so it can actually receive email). */
export async function hasMx(domain: string): Promise<boolean> {
  return (await mxStatus(domain)) === "mx";
}

/**
 * Live domain-resolution hit-rate from the cache — the diagnostic that tells us whether a low
 * contactable rate is a domain problem (few companies get a verified domain) or a name problem.
 *   attempts = companies we've tried to resolve, resolved = how many got a verified domain,
 *   withMx = of those, how many can receive mail (the email-buildable subset).
 */
export async function domainResolverStats(): Promise<{ attempts: number; resolved: number; withMx: number; rate: number }> {
  const c = await ensureCache();
  let resolved = 0, withMx = 0;
  for (const v of c.values()) { if (v.ok) { resolved++; if (v.mx) withMx++; } }
  const attempts = c.size;
  return { attempts, resolved, withMx, rate: attempts ? Math.round((resolved / attempts) * 100) / 100 : 0 };
}

/**
 * Verify ONE candidate. Two acceptance paths:
 *   STRONG  — live, not parked, and ON-BRAND (a distinctive company token on the homepage, or a
 *             same-root redirect). High confidence.
 *   MAIL    — live, not parked, token check MISSED (typical of JS-rendered homepages), BUT the
 *             domain publishes MX. A real, mail-receiving site at the company's own/guessed host is
 *             very likely theirs, so we accept it at LOWER confidence to BUILD an email guess. This
 *             is safe because nothing is ever sent on a guess: the continuous validator + port-25
 *             SMTP confirm every address before it can enroll. This path is the unlock that turns
 *             "named but no domain" rows into contactable ones (the email gate that was at ~6%).
 * A dead, parked, or no-MX-without-token domain is rejected (null).
 */
async function verify(domain: string, tokens: string[], via: string): Promise<DomainResolution | null> {
  const st = await homepageStatus(domain, tokens);
  if (!st.live || st.parked) return null;
  const mx = await hasMx(domain);
  if (st.onBrand) {
    // hint / source-url domains are inherently more trustworthy than a pure name guess.
    const base = via === "name_guess" ? 0.8 : 0.92;
    return { domain, confidence: mx ? base : base - 0.3, via, mx };
  }
  // Not provably on-brand, but a live mail-receiving site at this host — accept to build a guess.
  if (mx) return { domain, confidence: via === "name_guess" ? 0.45 : 0.6, via, mx: true };
  return null;
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * In-memory cache, lazily loaded once and persisted with a COALESCED debounced save. This is what
 * keeps the resolver stable at pool scale: without it every call did a full load+save of a growing
 * blob, and the accumulator's parallel domain workers raced and clobbered each other's writes.
 * Now reads are in-process and writes are batched into ~one save per burst.
 */
let mem: Map<string, CacheRow> | null = null;
let loading: Promise<void> | null = null;

async function ensureCache(): Promise<Map<string, CacheRow>> {
  if (mem) return mem;
  if (!loading) {
    loading = (async () => {
      const raw = (await loadSnapshot<Record<string, CacheRow>>(CACHE_KEY).catch(() => null)) || {};
      mem = new Map(Object.entries(raw));
    })().catch(() => { mem = new Map(); });
  }
  await loading;
  return mem ?? (mem = new Map());
}

const scheduleSave = debouncedSaver(CACHE_KEY, () => {
  let m = mem;
  if (!m) return {};
  // Bound the blob: when it grows past the cap, keep the freshest entries by last-checked time.
  if (m.size > MAX_CACHE) {
    m = new Map([...m.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_CACHE));
    mem = m;
  }
  return Object.fromEntries(m);
}, 1500);

/**
 * KEYLESS company-autocomplete domain sources (name → [{name, domain}]). Free, no scraping, no egress
 * — one clean JSON call. We run TWO independent providers so neither HubSpot (Clearbit) nor Brandfetch
 * going away can sink domain resolution:
 *   • PRIMARY  Clearbit  — ~95% and accurate; knows non-obvious domains (getjobber.com, postscript.io).
 *   • BACKUP   Brandfetch — ~100% coverage but occasional wrong-company hits, so it's held to a
 *     stricter DOMAIN-root match (a result whose NAME matches but whose domain is unrelated is rejected).
 * Both are cached (30d) so we hit each at most once per company per month — gentle on their rate limits.
 */
async function suggest(url: string): Promise<Array<{ name?: string; domain?: string }>> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}
const clearbitSuggest = (company: string) =>
  suggest(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(company)}`);
const brandfetchSuggest = (company: string) =>
  suggest(`https://api.brandfetch.io/v2/search/${encodeURIComponent(company)}`);

/** Pick the first brand-matched domain from an autocomplete list. `requireDomainMatch` (backup
 *  provider) demands the DOMAIN ROOT share a company token, rejecting wrong-company hits whose only
 *  match is the returned name (e.g. Brandfetch returning name "Vena Solutions" → exceleratesummit.com). */
function pickDomain(list: Array<{ name?: string; domain?: string }>, tokens: string[], requireDomainMatch = false): string | null {
  for (const cand of list.slice(0, 3)) {
    const dom = (cand.domain || "").toLowerCase().trim();
    if (!dom || !dom.includes(".") || !isCompanyHost(dom)) continue;
    const root = domainRoot(dom) || dom.split(".")[0];
    const nameHay = (cand.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const domHit = tokens.some((t) => t.length >= 3 && (root.includes(t) || t.includes(root)));
    const nameHit = tokens.some((t) => t.length >= 3 && nameHay.includes(t));
    if (domHit || (!requireDomainMatch && nameHit)) return domainBase(dom);
  }
  return null;
}

/** One autocomplete provider as a resolution: pick a brand-matched domain, then MX-check it. */
async function acResolution(
  company: string, tokens: string[],
  suggester: (c: string) => Promise<Array<{ name?: string; domain?: string }>>,
  strict: boolean, via: string, conf: number,
): Promise<DomainResolution | null> {
  const dom = pickDomain(await suggester(company), tokens, strict);
  if (!dom) return null;
  const mx = await hasMx(dom).catch(() => false);
  return { domain: dom, confidence: conf, via, mx };
}

/** Homepage-verify candidates (lead hint / source URL / anchor.com guesses), on-brand + MX checked. */
async function homepageResolution(company: string, tokens: string[], opts?: { sourceUrl?: string; hint?: string }): Promise<DomainResolution | null> {
  const candidates = candidatesFor(company, opts);
  if (!candidates.length) return null;
  const via = (d: string): string =>
    hostOf(opts?.hint) && domainBase(hostOf(opts!.hint!)) === d ? "hint"
    : hostOf(opts?.sourceUrl) && domainBase(hostOf(opts!.sourceUrl!)) === d ? "source_url"
    : "name_guess";
  const results = await Promise.all(candidates.map((d) => verify(d, tokens, via(d)).catch(() => null)));
  let best: DomainResolution | null = null;
  for (const r of results) if (r && (!best || r.confidence > best.confidence)) best = r;
  return best;
}

/** LAST RESORT: a name-guessed domain accepted only if it publishes MX (can receive mail). Pure DNS,
 *  no homepage fetch. Low confidence; only fires when every higher source missed — good enough to build
 *  a syntax email against (the whole point), flagged low so downstream treats it cautiously. */
async function mxGuessResolution(company: string): Promise<DomainResolution | null> {
  const bases = [...new Set([companyAnchor(company), orderedTokens(company)[0] || ""].filter((b) => b && b.length >= 3))];
  const cands = [...new Set(bases.flatMap((b) => ["com", "io", "co"].map((tld) => `${b}.${tld}`)))].slice(0, 6);
  for (const d of cands) {
    if (await hasMx(d).catch(() => false)) return { domain: d, confidence: 0.4, via: "mx_guess", mx: true };
  }
  return null;
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

  const cache = await ensureCache();
  const hit = cache.get(anchor);
  if (hit) {
    const fresh = Date.now() - hit.at < (hit.ok ? POS_TTL_MS : NEG_TTL_MS);
    if (fresh) return hit.ok ? { domain: hit.domain, confidence: hit.confidence, via: hit.via, mx: hit.mx } : null;
  }

  const tokens = brandTokens(company);

  // FAILSAFE CHAIN — independent free sources tried in order, first hit wins. No single provider is a
  // point of failure: if Clearbit (HubSpot) ever changes, Brandfetch carries; if both miss, the
  // homepage on-brand verify catches SMBs at anchor.com; the MX-only guess is the long-tail backstop.
  // Each step is bounded, timed-out, and never throws — a dead source just advances to the next. Add
  // more providers by dropping another step into this array.
  let best: DomainResolution | null = null;
  if (tokens.length) {
    const chain: Array<() => Promise<DomainResolution | null>> = [
      () => acResolution(company, tokens, clearbitSuggest, false, "clearbit", 0.9),
      () => acResolution(company, tokens, brandfetchSuggest, true, "brandfetch", 0.82),
      () => homepageResolution(company, tokens, opts),
      () => mxGuessResolution(company),
    ];
    for (const step of chain) {
      best = await step().catch(() => null);
      if (best) break;
    }
  }

  // Write the verdict back (positive or negative) so we don't re-probe constantly. The save is
  // debounced + coalesced (scheduleSave), so the accumulator's parallel domain workers don't each
  // pay a full-blob write — and they no longer clobber each other (shared in-memory map).
  try {
    cache.set(anchor, best
      ? { ...best, ok: true, at: Date.now() }
      : { domain: "", confidence: 0, via: "", mx: false, ok: false, at: Date.now() });
    scheduleSave();
  } catch { /* best-effort cache */ }

  return best;
}
