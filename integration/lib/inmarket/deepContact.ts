/**
 * RecruitersOS · In-Market · Deep free contact enrichment
 *
 * The email guesser builds a SYNTAX guess (first.last@domain) and the verifier only filters out
 * dead domains — so a "contactable" prospect is still an unconfirmed guess. This module is the
 * deep-pull layer that turns guesses into RICH, near-verified contacts for free, by reading what
 * the company already publishes:
 *
 *   1. HARVEST  — pull the company's own homepage + contact/about/team pages and scrape every
 *                 email address ON that domain (mailto: links + inline text). These are REAL,
 *                 published addresses — the ground truth for the company's email format.
 *   2. DIRECT   — if a harvested address actually belongs to the resolved decision-maker (their
 *                 name reconstructs the local-part), that IS their email — essentially verified,
 *                 for $0. The richest possible result.
 *   3. LEARN    — otherwise, match harvested addresses against the names we DID resolve on the
 *                 team page to learn the domain's real pattern (e.g. "jane.smith@acme.com" + a
 *                 "Jane Smith" on the page ⇒ this domain uses first.last). We then apply that
 *                 LEARNED pattern to the target person instead of the generic prior — lifting the
 *                 email from a ~40% blind guess to the company's actual convention.
 *
 * 100% free, bounded, egress-rotated, and cached per domain (so a company with 30 open roles is
 * harvested once). Best-effort: any failure returns null and the caller falls back to the plain
 * syntax guess. Precision-first: a learned pattern is only trusted when a real published address
 * confirms it, so we never invent a confidently-wrong address.
 */

import { loadSnapshot, debouncedSaver } from "../db";
import {
  EMAIL_PATTERNS, normalizeNamePart, emailDomainFrom, splitFullName,
} from "./email";

const FETCH_TIMEOUT_MS = 7_000;
const UA = "RecruitersOS/1.0 (+https://recruiteros.app; contact research)";
const CACHE_KEY = "inmarket_site_emails_v1";
const TTL_MS = 14 * 24 * 60 * 60 * 1000;   // re-harvest a domain fortnightly
const MAX_CACHE = 40_000;
const MAX_BODY = 80_000;                    // bytes scanned per page
const MAX_EMAILS = 60;                      // cap stored addresses per domain

/** Pages most likely to expose real personal emails, best-first. */
const HARVEST_PATHS = ["", "/contact", "/contact-us", "/about", "/about-us", "/team", "/leadership"];

/** Role / functional mailboxes — published, but not a PERSON. Excluded from pattern learning and
 *  never returned as a decision-maker's address. */
const ROLE_LOCALS = new Set([
  "info", "sales", "support", "contact", "hello", "admin", "help", "team", "office", "hr",
  "jobs", "careers", "recruiting", "talent", "people", "marketing", "press", "media", "billing",
  "accounts", "accounting", "finance", "legal", "privacy", "security", "abuse", "webmaster",
  "postmaster", "noreply", "no-reply", "donotreply", "mail", "newsletter", "general", "hi",
  "enquiries", "inquiries", "service", "customerservice", "feedback", "events", "partnerships",
]);

export interface PersonName { firstName?: string; lastName?: string; fullName?: string }

export interface DeepEmail {
  email: string;
  pattern: string;
  /** true = a published address that IS this person (verified-grade); false = the domain's
   *  learned pattern applied to this person (high-confidence, still unverified). */
  confirmed: boolean;
  via: "site_direct" | "site_pattern";
}

/* ------------------------------------------------------------------ */
/* Harvest (cached per domain)                                         */
/* ------------------------------------------------------------------ */

interface CacheRow { emails: string[]; at: number }
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
  if (m.size > MAX_CACHE) {
    m = new Map([...m.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_CACHE));
    mem = m;
  }
  return Object.fromEntries(m);
}, 1500);

async function fetchPage(url: string): Promise<string | null> {
  try {
    const { egressInit } = await import("../net/egress");
    const res = await fetch(url, egressInit({
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
    }));
    if (!res.ok) return null;
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype && !/html|xml|text/i.test(ctype)) return null;
    return (await res.text()).slice(0, MAX_BODY);
  } catch {
    return null;
  }
}

/** Scrape every on-domain email from a page's mailto: links and inline text. */
function emailsFromHtml(html: string, domain: string): string[] {
  const root = domain.toLowerCase();
  // local@(any subdomain of).domain — capture, then keep only those on this registrable domain.
  const re = new RegExp(`([a-z0-9](?:[a-z0-9._%+-]*[a-z0-9])?)@((?:[a-z0-9-]+\\.)*${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const local = m[1].toLowerCase();
    if (ROLE_LOCALS.has(local)) continue;
    if (local.length < 2 || local.length > 40) continue;
    out.add(`${local}@${root}`); // normalize onto the registrable domain
    if (out.size >= MAX_EMAILS) break;
  }
  return [...out];
}

/** All real, published, non-role emails on a company's domain (cached, bounded, egress-rotated). */
export async function harvestSiteEmails(urlOrDomain: string): Promise<string[]> {
  const domain = emailDomainFrom(urlOrDomain);
  if (!domain) return [];
  const cache = await ensureCache();
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.emails;

  const base = `https://${domain}`;
  const found = new Set<string>();
  let pagesHit = 0;
  for (const path of HARVEST_PATHS) {
    if (found.size >= MAX_EMAILS || pagesHit >= 4) break; // enough; stop probing
    const html = await fetchPage(base + path);
    if (!html) continue;
    pagesHit++;
    for (const e of emailsFromHtml(html, domain)) found.add(e);
  }
  const emails = [...found].slice(0, MAX_EMAILS);
  cache.set(domain, { emails, at: Date.now() });
  scheduleSave();
  return emails;
}

/* ------------------------------------------------------------------ */
/* Pattern matching                                                    */
/* ------------------------------------------------------------------ */

function partsOf(p: PersonName): { first: string; last: string; lastFull: string; f: string; l: string } | null {
  let first = normalizeNamePart(p.firstName);
  let lastFull = normalizeNamePart(p.lastName);
  if ((!first || !lastFull) && p.fullName) {
    const s = splitFullName(p.fullName);
    first = first || normalizeNamePart(s.firstName);
    lastFull = lastFull || normalizeNamePart(s.lastName);
  }
  if (!first) return null;
  const lastTokens = (p.lastName || splitFullName(p.fullName).lastName || "").trim().split(/[\s-]+/).filter(Boolean);
  const last = normalizeNamePart(lastTokens[lastTokens.length - 1] ?? lastFull);
  return { first, last, lastFull, f: first[0] ?? "", l: (last[0] ?? lastFull[0] ?? "") };
}

/** The pattern id that reconstructs `local` from this person's name, or null if none does. */
function patternOf(local: string, p: PersonName): string | null {
  const parts = partsOf(p);
  if (!parts) return null;
  const target = local.toLowerCase();
  for (const pat of EMAIL_PATTERNS) {
    const built = pat.build(parts);
    if (built && built === target) return pat.id;
  }
  return null;
}

function buildLocal(patternId: string, p: PersonName): string {
  const parts = partsOf(p);
  if (!parts) return "";
  const pat = EMAIL_PATTERNS.find((x) => x.id === patternId);
  return pat ? pat.build(parts) : "";
}

/* ------------------------------------------------------------------ */
/* Public: resolve a rich email for a specific person                  */
/* ------------------------------------------------------------------ */

/**
 * Try to resolve a RICH email for `person` at `domain` from the company's published addresses.
 *  - "site_direct"  → a harvested address that reconstructs from the person's name (verified-grade).
 *  - "site_pattern" → the domain's pattern, LEARNED from a harvested address that matched one of
 *                     `teamPeople`, applied to the person (high-confidence; still unverified).
 * Returns null when the site exposes nothing usable — the caller then falls back to guessEmail.
 */
export async function resolvePersonEmail(
  urlOrDomain: string,
  person: PersonName,
  teamPeople: PersonName[] = [],
): Promise<DeepEmail | null> {
  const domain = emailDomainFrom(urlOrDomain);
  if (!domain) return null;
  const emails = await harvestSiteEmails(domain).catch(() => [] as string[]);
  if (!emails.length) return null;

  // 1) DIRECT — a published address that is this very person.
  for (const e of emails) {
    const local = e.slice(0, e.lastIndexOf("@"));
    const pid = patternOf(local, person);
    if (pid) return { email: e, pattern: pid, confirmed: true, via: "site_direct" };
  }

  // 2) LEARN — find the domain's pattern from any harvested address that matches a known teammate.
  const tally = new Map<string, number>();
  for (const e of emails) {
    const local = e.slice(0, e.lastIndexOf("@"));
    for (const tp of teamPeople) {
      const pid = patternOf(local, tp);
      if (pid) { tally.set(pid, (tally.get(pid) ?? 0) + 1); break; }
    }
  }
  if (tally.size) {
    const bestPid = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const local = buildLocal(bestPid, person);
    if (local) return { email: `${local}@${domain}`, pattern: bestPid, confirmed: false, via: "site_pattern" };
  }
  return null;
}
