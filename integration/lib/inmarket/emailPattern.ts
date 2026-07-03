/**
 * RecruitersOS · In-Market · Per-domain email-PATTERN cache (the "learn once, construct many" layer)
 *
 * The finder (emailVerify.findVerifiedEmailReoon) walks a name's permutations through Reoon,
 * capped at REOON_MAX_CANDIDATES (default 6) and ordered by GLOBAL prevalence (first.last first).
 * Two structural misses fall out of that:
 *   1. A domain whose real format ranks 7-20 (e.g. `firstl`, `last.first`) is NEVER tried before
 *      the cap → the person is a permanent MISS even though the mailbox exists.
 *   2. We re-pay to rediscover the same format for every colleague at a company we already solved.
 *
 * Our leads cluster by company (many decision-makers per hiring-signal company), so learning a
 * domain's format ONCE and CONSTRUCTING every colleague's address from it is a large, near-free
 * lift on the Reoon credits we already own. This module is that cache:
 *   - learn the format from any CONFIRMED real email (Reoon-safe find, SMTP-found, site-published,
 *     GitHub commit author, or a Reoon-bulk-validated guess),
 *   - construct the single cached-format candidate and hand it back FIRST (always tried, even past
 *     the cap), so Reoon confirms on the first credit instead of brute-forcing or giving up.
 *
 * Nothing is ever emitted unverified: the constructed address is still Reoon-confirmed before use,
 * so a wrong cached format costs at most one extra credit and self-corrects. Fully gated OFF until
 * INMARKET_PATTERN_CACHE=1, so deploying it changes nothing until enabled.
 */

import { loadSnapshot, saveSnapshot } from "../db";
import { EMAIL_PATTERNS, normalizeNamePart, splitFullName, emailDomainFrom } from "./email";

const CACHE_KEY = "inmarket_email_pattern_v1";
const TTL_MS = 180 * 24 * 3600 * 1000; // 180 days — corporate formats change rarely
const FLUSH_DEBOUNCE_MS = 4_000;

/** Parts shape EMAIL_PATTERNS[].build expects (structurally matches email.ts's internal Parts). */
interface Parts { first: string; last: string; lastFull: string; f: string; l: string }

/** A learned format for one domain: a weighted tally across observed formats + the current winner. */
interface DomainEntry { tally: Record<string, number>; best: string; source: string; at: number }
type Cache = Record<string, DomainEntry>;

/** How much to trust one observation, by where the confirmed email came from. */
const SOURCE_WEIGHT: Record<string, number> = {
  github: 4,            // real address published in public commit metadata
  site_direct: 4,       // the person's own address, scraped off the company site
  smtp_found: 4,        // SMTP RCPT-confirmed mailbox
  reoon_found: 4,       // Reoon "safe" (real mailbox) on a specific permutation
  validated_external: 3, // Reoon bulk confirmed the guessed likelyEmail was deliverable
};
/** Sources we will NOT learn a format from (unconfirmed or format-uninformative). */
const UNTRUSTED = new Set(["", "guess", "catch_all"]);

export function patternCacheEnabled(): boolean {
  return process.env.INMARKET_PATTERN_CACHE === "1";
}
export function githubEnabled(): boolean {
  return !!(process.env.GITHUB_TOKEN || "").trim();
}

/* ------------------------------------------------------------------ */
/* Name → parts → local-part construction (mirrors email.ts internals) */
/* ------------------------------------------------------------------ */

/** Dotted-form surname token: last whitespace/hyphen piece. "van der Berg" → "berg". */
function lastToken(last: string | undefined | null): string {
  if (!last) return "";
  const parts = String(last).trim().split(/[\s-]+/).filter(Boolean);
  return normalizeNamePart(parts[parts.length - 1] ?? last);
}

function partsFor(fullName: string | undefined | null): Parts | null {
  const { firstName, lastName } = splitFullName(fullName);
  const first = normalizeNamePart(firstName);
  if (!first) return null;
  const last = lastToken(lastName);
  const lastFull = normalizeNamePart(lastName);
  return { first, last, lastFull, f: first[0] ?? "", l: last[0] ?? "" };
}

/** Every candidate address for a name+domain WITH its pattern id, best-first, de-duplicated. */
export function candidatesWithIds(fullName: string | undefined | null, domain: string): Array<{ email: string; pattern: string }> {
  const p = partsFor(fullName);
  if (!p || !domain) return [];
  const seen = new Set<string>();
  const out: Array<{ email: string; pattern: string }> = [];
  for (const pat of EMAIL_PATTERNS) {
    const local = pat.build(p);
    if (!local) continue;
    const email = `${local}@${domain}`;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ email, pattern: pat.id });
  }
  return out;
}

/** Construct the single address for a name+domain in a specific format, or null if unbuildable. */
export function constructFromPattern(fullName: string | undefined | null, domain: string, patternId: string): string | null {
  const p = partsFor(fullName);
  if (!p || !domain) return null;
  const pat = EMAIL_PATTERNS.find((x) => x.id === patternId);
  if (!pat) return null;
  const local = pat.build(p);
  return local ? `${local}@${domain}` : null;
}

/** Given a person's name and a KNOWN-real email, which format id produced its local-part? null if none match. */
export function inferPattern(fullName: string | undefined | null, email: string | undefined | null): string | null {
  const e = (email || "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return null;
  const local = e.slice(0, at);
  const p = partsFor(fullName);
  if (!p) return null;
  for (const pat of EMAIL_PATTERNS) {
    const built = pat.build(p);
    if (built && built === local) return pat.id;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The cache (in-memory + debounced snapshot flush)                     */
/* ------------------------------------------------------------------ */

let mem: Cache | null = null;
let dirty = false;
let lastFlush = 0;
let backfilled = false;

async function cache(): Promise<Cache> {
  if (mem) return mem;
  mem = (await loadSnapshot<Cache>(CACHE_KEY).catch(() => null)) || {};
  return mem;
}

/** Persist the cache if it changed and the debounce window has passed (or force). */
export async function flushPatternCache(force = false): Promise<void> {
  if (!dirty || !mem) return;
  const now = Date.now();
  if (!force && now - lastFlush < FLUSH_DEBOUNCE_MS) return;
  lastFlush = now;
  dirty = false;
  await saveSnapshot(CACHE_KEY, mem).catch(() => { dirty = true; });
}

function argmax(tally: Record<string, number>): string {
  let best = "", top = -Infinity;
  for (const [k, v] of Object.entries(tally)) if (v > top) { top = v; best = k; }
  return best;
}

/** Record one observation of `patternId` for `domain`, weighted by source trust. */
async function record(domain: string, patternId: string, source: string): Promise<void> {
  const d = (domain || "").trim().toLowerCase();
  if (!d || !patternId) return;
  const w = SOURCE_WEIGHT[source] ?? 1;
  const c = await cache();
  const e: DomainEntry = c[d] || { tally: {}, best: patternId, source, at: 0 };
  e.tally[patternId] = (e.tally[patternId] || 0) + w;
  e.best = argmax(e.tally);
  e.source = source;
  e.at = Date.now();
  c[d] = e;
  dirty = true;
  void flushPatternCache();
}

/** Learn a domain's format from a CONFIRMED real email (no-op for untrusted/unconfirmed sources). */
export async function learnFromConfirmedEmail(fullName: string | undefined | null, email: string | undefined | null, source: string): Promise<void> {
  if (!patternCacheEnabled()) return;
  if (UNTRUSTED.has(source)) return;
  const patternId = inferPattern(fullName, email);
  if (!patternId) return; // real email whose format doesn't match a known permutation of THIS name → skip
  const domain = (email || "").slice((email || "").lastIndexOf("@") + 1).toLowerCase();
  await record(domain, patternId, source);
}

/** The cached winning format for a domain, or null (miss / expired / disabled). */
export async function getDomainPattern(domain: string): Promise<{ pattern: string; source: string } | null> {
  if (!patternCacheEnabled()) return null;
  const d = (domain || "").trim().toLowerCase();
  if (!d) return null;
  const e = (await cache())[d];
  if (!e || !e.best) return null;
  if (Date.now() - e.at > TTL_MS) return null;
  return { pattern: e.best, source: e.source };
}

/**
 * Candidate ordering for the finder: if we KNOW this domain's format, put the constructed address
 * FIRST (always tried, even past the cap), then a few generic fallbacks. Otherwise the plain
 * best-first permutation set, capped. Returns [] when the name/domain is unusable.
 */
export async function orderedCandidatesForDomain(
  fullName: string | undefined | null,
  urlOrDomain: string,
  max: number,
): Promise<Array<{ email: string; pattern: string }>> {
  const domain = emailDomainFrom(urlOrDomain) || (urlOrDomain || "").toLowerCase();
  const all = candidatesWithIds(fullName, domain);
  if (!all.length) return [];
  const cap = Math.max(1, max);
  const cached = await getDomainPattern(domain);
  if (cached) {
    const lead = all.find((c) => c.pattern === cached.pattern);
    if (lead) {
      const rest = all.filter((c) => c.email !== lead.email).slice(0, Math.max(0, cap - 1));
      return [lead, ...rest];
    }
  }
  return all.slice(0, cap);
}

/* ------------------------------------------------------------------ */
/* Backfill: seed the cache from emails the pipeline already confirmed  */
/* ------------------------------------------------------------------ */

interface BackfillRow { managerName?: string; likelyEmail?: string; emailSource?: string; emailValidated?: boolean; emailCatchAll?: boolean }

/**
 * One-time (per process) seed of the cache from rows that already carry a CONFIRMED real email.
 * This is what makes the ~misses recoverable immediately: every already-validated colleague at a
 * company teaches that company's format to the colleagues still missing an address.
 */
export async function backfillFromRows(rows: BackfillRow[]): Promise<{ learned: number; domains: number }> {
  if (!patternCacheEnabled() || backfilled) return { learned: 0, domains: 0 };
  backfilled = true;
  let learned = 0;
  const before = Object.keys(await cache()).length;
  for (const r of rows) {
    if (!r || !r.managerName || !r.likelyEmail) continue;
    if (r.emailCatchAll) continue;                 // catch-all address can't confirm a format
    if (!r.emailValidated) continue;               // only learn from confirmed-real emails
    if (UNTRUSTED.has(r.emailSource || "")) continue;
    const patternId = inferPattern(r.managerName, r.likelyEmail);
    if (!patternId) continue;
    const domain = r.likelyEmail.slice(r.likelyEmail.lastIndexOf("@") + 1).toLowerCase();
    await record(domain, patternId, r.emailSource || "validated_external");
    learned++;
  }
  await flushPatternCache(true);
  const after = Object.keys(await cache()).length;
  return { learned, domains: after - before };
}

/* ------------------------------------------------------------------ */
/* V2 (opt-in, GITHUB_TOKEN): seed a domain's format from public commits */
/* ------------------------------------------------------------------ */

/**
 * Best-effort: for a domain with no learned format yet, find one real @domain email in public
 * GitHub commit metadata (author name + email), infer the format, and cache it. Guesses the org
 * from the domain label (acme.com → "acme"), which is right for a large share of companies.
 * Returns the seed email (also recorded) or null. Rate-limited: needs GITHUB_TOKEN (5k/hr) to be
 * useful; runs only in the controlled enrichment pass, never inline in the hot finder tick.
 */
export async function seedFromGithub(domain: string): Promise<string | null> {
  if (!patternCacheEnabled() || !githubEnabled()) return null;
  const d = (domain || "").trim().toLowerCase();
  if (!d || !d.includes(".")) return null;
  if (await getDomainPattern(d)) return null; // already known
  const token = (process.env.GITHUB_TOKEN || "").trim();
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "recruiteros-emailpattern" };
  const org = d.split(".")[0];
  try {
    const reposRes = await fetch(`https://api.github.com/orgs/${encodeURIComponent(org)}/repos?per_page=5&sort=pushed`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!reposRes.ok) return null;
    const repos: any[] = await reposRes.json().catch(() => []);
    for (const repo of Array.isArray(repos) ? repos.slice(0, 5) : []) {
      const full = repo?.full_name;
      if (!full) continue;
      const commitsRes = await fetch(`https://api.github.com/repos/${full}/commits?per_page=30`, { headers, signal: AbortSignal.timeout(15_000) });
      if (!commitsRes.ok) continue;
      const commits: any[] = await commitsRes.json().catch(() => []);
      for (const c of Array.isArray(commits) ? commits : []) {
        const email = String(c?.commit?.author?.email ?? "").toLowerCase();
        const name = String(c?.commit?.author?.name ?? "");
        if (!email.endsWith("@" + d) || !name) continue;
        const patternId = inferPattern(name, email);
        if (!patternId) continue;
        await record(d, patternId, "github");
        return email;
      }
    }
  } catch { /* transient / rate-limit → give up quietly */ }
  return null;
}

/** Diagnostics: current cache size + a few sample entries. */
export async function patternCacheStats(): Promise<{ enabled: boolean; domains: number; samples: Array<{ domain: string; best: string; source: string }> }> {
  const c = await cache();
  const keys = Object.keys(c);
  return {
    enabled: patternCacheEnabled(),
    domains: keys.length,
    samples: keys.slice(0, 10).map((k) => ({ domain: k, best: c[k].best, source: c[k].source })),
  };
}
