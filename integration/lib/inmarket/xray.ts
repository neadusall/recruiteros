/**
 * RecruitersOS · In-Market · Google/Bing X-RAY people finder
 *
 * THE JOB: given a COMPANY and a JOB TITLE, return the real human who holds that title —
 * first name, last name, their LinkedIn URL, and a confidence score — using only free public
 * search. This is the "Google X-ray boolean" method a sourcer runs by hand, encoded:
 *
 *     site:linkedin.com/in "Acme" ("VP of Engineering" OR "Vice President of Engineering")
 *
 * LinkedIn renders every public profile's <title> as "Name - Title - Company | LinkedIn", and
 * the search engines index that. So an X-ray that targets linkedin.com/in and reads the result
 * TITLE gives us the name + title + company for free, without ever loading (or scraping) the
 * LinkedIn page itself. This module:
 *
 *   1. EXPANDS the title into its real-world variants (VP ⇄ Vice President, CTO ⇄ Chief
 *      Technology Officer, "Head of X" ⇄ "X Lead"), so a strict quoted search still matches.
 *   2. BUILDS precise→broad boolean queries and runs them across independent engines
 *      (DuckDuckGo, Bing, Mojeek), each rotated + throttle-aware, so one engine resting never
 *      stops the find.
 *   3. PARSES every linkedin.com/in result into {name, title, company, url} with strict name
 *      and title guards (no nav/boilerplate, no activity-post titles).
 *   4. SCORES each candidate on title-fit + company-match + having a real profile URL, and
 *      returns them ranked.
 *   5. PAIRS the winner with the free email-syntax model and runs the free deliverability
 *      verifier — so the caller gets {person, email, emailCheck} in one call, ready to confirm
 *      before any send.
 *
 * It is also exposed as a `PeopleGraph` (`xrayPeopleGraph`) so it slots straight into
 * resolveHiringManager / the hiring waterfall alongside the other free graphs.
 *
 * Free + safe to run hard: every request is egress-IP rotated when the egress pool is configured
 * (falls back to a normal fetch otherwise), short-timeout, and de-duplicated per (company,title).
 */

import { companyAnchor, normalizeTitle } from "../signals/hiring/normalize";
import {
  splitFullName,
  guessEmail,
  emailDomainFrom,
  type EmailGuess,
} from "./email";
import { checkEmailFree, type EmailCheck } from "./emailVerify";
import type { PeopleGraph, PeopleQuery, PersonCandidate } from "../signals/hiring";

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

const FETCH_TIMEOUT_MS = 9_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// A real browser UA — engines serve scrape-friendly HTML and challenge less.
const SEARCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/* ------------------------------------------------------------------ */
/* Name + title guards                                                 */
/* ------------------------------------------------------------------ */

/** Title-Case tokens that are never part of a person's name (nav / boilerplate / topic words). */
const NON_NAME = new Set([
  "Privacy", "Policy", "Terms", "Team", "About", "Our", "The", "Contact", "Careers", "Career",
  "Home", "Company", "Leadership", "People", "Board", "Press", "Blog", "News", "Login", "Sign",
  "Product", "Products", "Solutions", "Platform", "Pricing", "Resources", "Support", "Jobs",
  "Apply", "Inc", "LLC", "Engineering", "Marketing", "Operations", "Finance", "Design", "Sales",
  "Chief", "Officer", "President", "Vice", "Head", "Director", "Manager", "Lead", "Senior",
  "LinkedIn", "Profile", "Profiles", "View", "Posts", "Experience", "Profil", "Professional",
]);

/** A 2–3 token Title-Case string that looks like a real personal name. */
export function looksLikeName(s: string): boolean {
  const parts = s.trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 3) return false;
  // strip trailing punctuation/initials before checking the stopword set
  if (parts.some((p) => NON_NAME.has(p.replace(/[.'’,-].*$/, "")))) return false;
  if (parts.some((p) => p.length < 2 || p === p.toUpperCase())) return false;
  // every token must start with an uppercase letter (allow O'Brien, Jean-Luc, accents)
  if (!parts.every((p) => /^[\p{Lu}]/u.test(p))) return false;
  return true;
}

const TITLE_KEYWORD =
  /\b(chief|c[tefoma]o|cro|cpo|chro|ciso|vp|svp|evp|avp|vice\s+president|head|director|manager|lead|president|founder|co-?founder|partner|principal|officer|owner|architect|engineer|designer|recruiter|controller|counsel)\b/i;

function looksLikeTitle(s: string | undefined): boolean {
  return !!s && TITLE_KEYWORD.test(s);
}

/* ------------------------------------------------------------------ */
/* Title-variant expansion (the heart of a high-recall X-ray)          */
/* ------------------------------------------------------------------ */

/** Bidirectional abbreviation pairs applied to the title to widen the quoted match. */
const ABBREV: Array<[RegExp, string]> = [
  [/\bvice president\b/gi, "VP"],
  [/\bsenior vice president\b/gi, "SVP"],
  [/\bexecutive vice president\b/gi, "EVP"],
  [/\bchief executive officer\b/gi, "CEO"],
  [/\bchief technology officer\b/gi, "CTO"],
  [/\bchief financial officer\b/gi, "CFO"],
  [/\bchief operating officer\b/gi, "COO"],
  [/\bchief marketing officer\b/gi, "CMO"],
  [/\bchief revenue officer\b/gi, "CRO"],
  [/\bchief product officer\b/gi, "CPO"],
  [/\bchief people officer\b/gi, "CHRO"],
  [/\bchief information security officer\b/gi, "CISO"],
];
/** The reverse expansion (abbrev → long form). */
const EXPAND: Array<[RegExp, string]> = [
  [/\bvp\b/gi, "Vice President"],
  [/\bsvp\b/gi, "Senior Vice President"],
  [/\bevp\b/gi, "Executive Vice President"],
  [/\bceo\b/gi, "Chief Executive Officer"],
  [/\bcto\b/gi, "Chief Technology Officer"],
  [/\bcfo\b/gi, "Chief Financial Officer"],
  [/\bcoo\b/gi, "Chief Operating Officer"],
  [/\bcmo\b/gi, "Chief Marketing Officer"],
  [/\bcro\b/gi, "Chief Revenue Officer"],
  [/\bcpo\b/gi, "Chief Product Officer"],
  [/\bchro\b/gi, "Chief People Officer"],
  [/\bciso\b/gi, "Chief Information Security Officer"],
];

/**
 * Expand a job title into its highest-value search variants, best-first and de-duplicated.
 * "VP of Engineering" → ["VP of Engineering", "Vice President of Engineering", "VP Engineering",
 *                        "VP, Engineering"]. Capped so the OR-clause stays tight.
 */
export function expandTitle(title: string): string[] {
  const base = title.trim().replace(/\s+/g, " ");
  if (!base) return [];
  const out = new Set<string>([base]);

  // abbrev ⇄ long form, both directions
  for (const [re, rep] of ABBREV) if (re.test(base)) out.add(base.replace(re, rep));
  for (const [re, rep] of EXPAND) if (re.test(base)) out.add(base.replace(re, rep));

  // punctuation variants for every form we have so far
  for (const t of [...out]) {
    out.add(t.replace(/\bof\b/gi, "").replace(/\s+/g, " ").trim()); // "VP of Eng" → "VP Eng"
    out.add(t.replace(/\bof\b/gi, ",").replace(/\s+,/g, ",")); // "VP of Eng" → "VP, Eng"
  }
  return [...out].map((s) => s.trim()).filter(Boolean).slice(0, 5);
}

/* ------------------------------------------------------------------ */
/* Boolean X-ray query builder                                         */
/* ------------------------------------------------------------------ */

/** Build the boolean X-ray queries, precise → broad. The first that yields a hit wins. */
export function buildXrayQueries(company: string, title: string): string[] {
  const variants = expandTitle(title);
  const titleOr = variants.length
    ? "(" + variants.map((t) => `"${t}"`).join(" OR ") + ")"
    : `"${title}"`;
  const co = `"${company}"`;
  return [
    // 1) tight: LinkedIn profiles with the exact company + a title variant
    `site:linkedin.com/in ${co} ${titleOr}`,
    // 2) company current-employer phrasing ("· Title at Company")
    `site:linkedin.com/in ${titleOr} "at ${company}"`,
    // 3) drop the site filter — many engines surface the LinkedIn result anyway, plus exec DBs
    `${co} ${titleOr} linkedin`,
  ];
}

/* ------------------------------------------------------------------ */
/* LinkedIn result-title parser                                        */
/* ------------------------------------------------------------------ */

export interface ParsedProfile {
  fullName: string;
  title?: string;
  company?: string;
  linkedinUrl?: string;
}

const SEP = /\s+[-–—•·|]\s+/; // separators LinkedIn/engines use between name · title · company

function cleanText(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&#x27;|&rsquo;|&apos;/g, "'")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse one search-result title (and optional URL) into a profile. Handles the common LinkedIn
 * shapes:
 *   "Jane Doe - VP of Engineering - Acme | LinkedIn"
 *   "Jane Doe - Acme - VP of Engineering - LinkedIn"
 *   "Jane Doe – VP Engineering – Acme"
 *   "Jane Doe - Acme | LinkedIn"            (no title segment)
 * Rejects activity-post titles ("Jane Doe on LinkedIn: we're hiring…") and anything whose first
 * segment isn't a real personal name. Returns null on a miss.
 */
export function parseLinkedInResult(rawTitle: string, url?: string): ParsedProfile | null {
  let t = cleanText(rawTitle);
  if (!t) return null;
  // Activity / post / company-page results are not a person.
  if (/\bon linkedin\b\s*:/i.test(t)) return null;
  // Strip the trailing "| LinkedIn" / "- LinkedIn" / "… LinkedIn" branding.
  t = t.replace(/\s*[-–—|]\s*linkedin\s*$/i, "").replace(/\s*\|\s*linkedin.*$/i, "").trim();

  const segs = t.split(SEP).map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return null;

  const name = segs[0];
  if (!looksLikeName(name)) return null;

  // Among the remaining segments, the first title-bearing one is the title; a non-title segment
  // is taken as the company (LinkedIn orders them name · title · company, but some engines swap
  // the last two, so we detect by content rather than by position).
  let title: string | undefined;
  let company: string | undefined;
  for (const seg of segs.slice(1)) {
    if (!title && looksLikeTitle(seg)) title = seg;
    else if (!company) company = seg;
  }

  // Pull the canonical profile URL when we have one (decoded upstream).
  let linkedinUrl: string | undefined;
  if (url && /linkedin\.com\/in\//i.test(url)) {
    linkedinUrl = url.split(/[?#]/)[0];
  }

  return { fullName: name, title, company, linkedinUrl };
}

/* ------------------------------------------------------------------ */
/* Engine layer (DuckDuckGo / Bing / Mojeek), throttle-aware           */
/* ------------------------------------------------------------------ */

interface Engine {
  id: string;
  url: (q: string) => string;
}

const ENGINES: Engine[] = [
  { id: "duckduckgo", url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}` },
  { id: "bing", url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=20` },
  { id: "ddg_lite", url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}` },
  { id: "mojeek", url: (q) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}` },
];

async function searchFetch(url: string): Promise<{ status: number; body: string | null }> {
  try {
    const init: RequestInit = {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": SEARCH_UA,
        Accept: "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
    };
    // Use egress rotation when available; fall back to a plain fetch locally.
    let res: Response;
    try {
      const { egressFetch } = await import("../net/egress");
      res = await egressFetch(url, init);
    } catch {
      res = await fetch(url, init);
    }
    return { status: res.status, body: res.ok ? await res.text() : null };
  } catch {
    return { status: 0, body: null };
  }
}

function isThrottle(status: number, body: string | null): boolean {
  if (status !== 200) return true;
  return (
    !!body &&
    /unusual traffic|captcha|are you a robot|automated queries|verify you are human|too many requests|challenge-platform/i.test(
      body,
    )
  );
}

/** Decode a DuckDuckGo redirect href ("//duckduckgo.com/l/?uddg=ENC") to the real target. */
function decodeHref(href: string): string {
  let h = href.trim();
  const m = h.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try { h = decodeURIComponent(m[1]); } catch { /* keep raw */ }
  }
  if (h.startsWith("//")) h = "https:" + h;
  return h;
}

/**
 * Pull every (title, url) pair whose href points at a linkedin.com/in profile, engine-agnostic:
 * we walk all <a href=…>text</a> tags, decode DDG redirects, and keep the LinkedIn-profile ones.
 * This captures BOTH the visible "Name - Title - Company" text AND the canonical profile URL.
 */
function extractLinkedInResults(html: string): Array<{ title: string; url: string }> {
  const out: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 30) {
    const url = decodeHref(m[1]);
    if (!/linkedin\.com\/in\//i.test(url)) continue;
    const title = cleanText(m[2]);
    if (!title) continue;
    const key = url.split(/[?#]/)[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, url });
  }
  return out;
}

/** Generic fallback: result titles even when the engine doesn't expose the /in/ href inline. */
function extractResultTitles(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/gi, // ddg
    /<h2>\s*<a [^>]*>([\s\S]*?)<\/a>/gi, // bing / mojeek
    /<a[^>]+class=["']result-link["'][^>]*>([\s\S]*?)<\/a>/gi, // ddg lite
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && out.length < 30) {
      const t = cleanText(m[1]);
      if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

export interface XrayCandidate extends PersonCandidate {
  /** 0..1 fit for "is this the person with that title at that company". */
  score: number;
  /** Which engine + query surfaced them. */
  via: string;
}

function scoreCandidate(p: ParsedProfile, company: string, title: string): number {
  const wantTitle = normalizeTitle(title);
  const haveTitle = normalizeTitle(p.title);
  const wantCo = companyAnchor(company);
  const haveCo = companyAnchor(p.company);

  let s = 0;
  // Title fit (0.5): exact-ish contain either direction, else token overlap.
  if (haveTitle && wantTitle) {
    if (haveTitle === wantTitle || haveTitle.includes(wantTitle) || wantTitle.includes(haveTitle)) s += 0.5;
    else {
      const a = new Set(haveTitle.split(" "));
      const b = wantTitle.split(" ");
      const overlap = b.filter((w) => a.has(w)).length / Math.max(1, b.length);
      s += 0.5 * overlap;
    }
  }
  // Company match (0.35): the strongest disambiguator (rules out same-name people elsewhere).
  if (haveCo && wantCo) s += haveCo === wantCo ? 0.35 : 0;
  else if (!haveCo) s += 0.1; // engine didn't surface a company segment — mild benefit of the doubt
  // Real profile URL (0.15): a captured /in/ link means this is an actual profile, not a stray line.
  if (p.linkedinUrl) s += 0.15;
  return Math.min(1, Math.round(s * 100) / 100);
}

/* ------------------------------------------------------------------ */
/* The X-ray search                                                    */
/* ------------------------------------------------------------------ */

export interface XrayOptions {
  /** Stop once a candidate scores at/above this (default 0.6). */
  acceptScore?: number;
  /** Max engines to try per query (default all). */
  maxEngines?: number;
  /** Inject a fetcher (tests). Defaults to the throttle-aware multi-engine fetch. */
  fetchImpl?: (url: string) => Promise<{ status: number; body: string | null }>;
}

export interface XrayLogEntry {
  engine: string;
  query: string;
  status: number;
  throttled: boolean;
  found: number;
}

export interface XrayResult {
  company: string;
  title: string;
  queries: string[];
  candidates: XrayCandidate[];
  best: XrayCandidate | null;
  log: XrayLogEntry[];
}

const cache = new Map<string, { at: number; result: XrayResult }>();

/**
 * Run the X-ray for one (company, title) and return ranked candidates. Walks the boolean queries
 * precise→broad across the engine rotation; the first engine that yields parsed profiles for a
 * query wins that query, and we stop early once a candidate clears `acceptScore`.
 */
export async function xraySearch(
  company: string,
  title: string,
  opts: XrayOptions = {},
): Promise<XrayResult> {
  const accept = opts.acceptScore ?? 0.6;
  const queries = buildXrayQueries(company, title);
  const fetcher = opts.fetchImpl ?? searchFetch;
  const engines = opts.maxEngines ? ENGINES.slice(0, opts.maxEngines) : ENGINES;

  const key = `${companyAnchor(company)}::${normalizeTitle(title)}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS && !opts.fetchImpl) return cached.result;

  const byName = new Map<string, XrayCandidate>();
  const log: XrayLogEntry[] = [];

  outer: for (const query of queries) {
    for (const eng of engines) {
      let throttled = false;
      let parsed: ParsedProfile[] = [];
      // up to 2 attempts — a throttle rotates to a fresh egress IP on the retry.
      for (let attempt = 0; attempt < 2; attempt++) {
        const { status, body } = await fetcher(eng.url(query));
        if (isThrottle(status, body)) { throttled = true; continue; }
        throttled = false;
        if (body) {
          const linked = extractLinkedInResults(body);
          parsed = linked
            .map((r) => parseLinkedInResult(r.title, r.url))
            .filter((p): p is ParsedProfile => !!p);
          // Fallback: parse plain result titles if no /in/ hrefs were exposed.
          if (!parsed.length) {
            parsed = extractResultTitles(body)
              .map((tt) => parseLinkedInResult(tt))
              .filter((p): p is ParsedProfile => !!p);
          }
        }
        break;
      }
      log.push({ engine: eng.id, query, status: throttled ? 429 : 200, throttled, found: parsed.length });
      if (throttled || !parsed.length) continue;

      for (const p of parsed) {
        const score = scoreCandidate(p, company, title);
        if (score <= 0) continue;
        const k = p.fullName.toLowerCase();
        const split = splitFullName(p.fullName);
        const cand: XrayCandidate = {
          fullName: p.fullName,
          firstName: split.firstName,
          lastName: split.lastName,
          title: p.title,
          headline: p.title,
          companyName: p.company || company,
          linkedinUrl: p.linkedinUrl,
          source: "xray",
          score,
          via: `${eng.id}`,
        };
        const prev = byName.get(k);
        if (!prev || cand.score > prev.score) byName.set(k, cand);
      }
      // This engine produced results for this query → move to the next query (don't double-spend).
      const top = [...byName.values()].sort((a, b) => b.score - a.score)[0];
      if (top && top.score >= accept) break outer;
      break; // next query
    }
  }

  const candidates = [...byName.values()].sort((a, b) => b.score - a.score);
  const result: XrayResult = {
    company,
    title,
    queries,
    candidates,
    best: candidates[0] ?? null,
    log,
  };
  if (!opts.fetchImpl) cache.set(key, { at: Date.now(), result });
  return result;
}

/* ------------------------------------------------------------------ */
/* Pair: name → email guess → free verify                             */
/* ------------------------------------------------------------------ */

export interface XrayContact {
  company: string;
  title: string;
  queries: string[];
  person: XrayCandidate | null;
  /** Best-guess work email (syntax only, unverified) when we have a name + domain. */
  email: EmailGuess | null;
  /** Free deliverability verdict on the guessed email (role/disposable/MX/syntax). */
  emailCheck: EmailCheck | null;
  candidates: XrayCandidate[];
  log: XrayLogEntry[];
}

/**
 * The full pipeline the user asked for: X-ray the (company, title) for a real person, then pair
 * the winner with the email-syntax model and run the free verifier — so the result is a named
 * person + their most-likely email + an honest deliverability verdict, ready to confirm before
 * any outreach. `domain` is required to build an email (we never fabricate a domain from a name).
 */
export async function findContactByTitle(
  company: string,
  title: string,
  opts: XrayOptions & { domain?: string } = {},
): Promise<XrayContact> {
  const res = await xraySearch(company, title, opts);
  const person = res.best;

  let email: EmailGuess | null = null;
  let emailCheck: EmailCheck | null = null;
  const domain = emailDomainFrom(opts.domain);
  if (person && domain) {
    const g = guessEmail(person.firstName, person.lastName, domain);
    if (g.email) {
      email = g;
      emailCheck = await checkEmailFree(g.email).catch(() => null);
    }
  }

  return {
    company,
    title,
    queries: res.queries,
    person,
    email,
    emailCheck,
    candidates: res.candidates,
    log: res.log,
  };
}

/* ------------------------------------------------------------------ */
/* PeopleGraph adapter — slot into resolveHiringManager / waterfall    */
/* ------------------------------------------------------------------ */

/**
 * Expose the X-ray as a `PeopleGraph`, so it composes with every other free graph in
 * resolveHiringManager (which then scores + tiers the candidates with the rest). Searches the
 * first/best target title from the query.
 */
export function xrayPeopleGraph(): PeopleGraph {
  return {
    id: "xray",
    isConfigured: () => true,
    async search(query: PeopleQuery): Promise<PersonCandidate[]> {
      const company = query.companyName;
      if (!company) return [];
      const titles = query.titles?.length ? query.titles : ["Head of", "VP", "Director"];
      // Search the top couple of target titles, merge by name.
      const byName = new Map<string, PersonCandidate>();
      for (const title of titles.slice(0, 2)) {
        const res = await xraySearch(company, title).catch(() => null);
        if (!res) continue;
        for (const c of res.candidates) {
          const k = c.fullName.toLowerCase();
          if (!byName.has(k)) byName.set(k, c);
        }
        if (res.best && res.best.score >= 0.6) break; // strong hit; no need to widen
      }
      const merged = [...byName.values()];
      return query.limit ? merged.slice(0, query.limit) : merged;
    },
  };
}
