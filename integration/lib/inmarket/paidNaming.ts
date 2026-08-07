/**
 * RecruitersOS · In-Market · cheap-first paid NAMING fallback (RapidAPI people-search)
 *
 * Finding the decision-maker's NAME is the bottleneck: the free sources (company team page, news
 * appointments, search-result scraping, GitHub) resolve a name for ~30-40% of companies. This is
 * the cheap paid fallback for the MISSES — a RapidAPI people-search (a LinkedIn-data API or a SERP
 * API) that returns the name for ~$0.005-0.02. It is only ever called when free naming fails, so we
 * pay for misses only (same cheapest-first policy as paidEmail/Icypeas).
 *
 * ENV-GATED: returns [] (a no-op, zero spend) unless RAPID_NAMING_KEY is set, so it costs nothing
 * until you opt in. Add the key to .env.production to switch the extra naming on.
 *
 * PROVIDER-AGNOSTIC (you pick the RapidAPI listing). The host/path/method/params are env-configured
 * and the response parser is tolerant — it pulls {name, title} out of EITHER a structured people
 * array (full_name / headline / job_title) OR SERP-style result titles ("Name - Title - Company").
 * Defaults target Fresh LinkedIn Profile Data (you already have a client stub for it). To point it
 * at a different RapidAPI API, set the RAPID_NAMING_* env vars below — no redeploy of code needed.
 *
 *   RAPID_NAMING_KEY            (required) your RapidAPI X-RapidAPI-Key — enables the rung
 *   RAPID_NAMING_HOST           default "fresh-linkedin-profile-data.p.rapidapi.com"
 *   RAPID_NAMING_PATH           default "/search-employees"
 *   RAPID_NAMING_METHOD         default "POST"  (GET also supported)
 *   RAPID_NAMING_QUERY_PARAM    default "keywords"  (the param that carries the search string)
 *   RAPID_NAMING_COMPANY_PARAM  optional extra param to also send the bare company name
 */

import { splitFullName } from "./email";
import type { PersonCandidate } from "../signals/hiring";

const TIMEOUT_MS = 9_000;

/** True once the paid naming rung is configured. */
export function paidNamingEnabled(): boolean {
  return !!process.env.RAPID_NAMING_KEY;
}

const cfg = {
  host: () => process.env.RAPID_NAMING_HOST || "fresh-linkedin-profile-data.p.rapidapi.com",
  path: () => process.env.RAPID_NAMING_PATH || "/search-employees",
  method: () => (process.env.RAPID_NAMING_METHOD || "POST").toUpperCase(),
  queryParam: () => process.env.RAPID_NAMING_QUERY_PARAM || "keywords",
  companyParam: () => process.env.RAPID_NAMING_COMPANY_PARAM || "",
};

/* ------------------------------------------------------------------ */
/* Local name/title guards (standalone so this file has no import cycle */
/* with decisionMaker.ts, which imports THIS).                          */
/* ------------------------------------------------------------------ */

const NON_NAME = new Set([
  "Privacy", "Policy", "Terms", "Team", "About", "Our", "The", "Contact", "Careers", "Home",
  "Company", "Leadership", "People", "Board", "Press", "Blog", "News", "Login", "Product",
  "Solutions", "Platform", "Pricing", "Resources", "Support", "Jobs", "Apply", "Inc", "LLC",
  "Engineering", "Marketing", "Operations", "Finance", "Design", "Sales", "Chief", "Officer",
  "President", "Vice", "Head", "Director", "Manager", "Lead", "Senior", "Remote", "Hybrid",
  "LinkedIn", "Profile", "Profiles",
  // function words that begin marketing CTAs — never a real name token.
  "For", "And", "To", "With", "Your", "From", "Become", "Today", "Free", "Best", "Or", "An",
  "Build", "Grow", "Discover", "Explore", "Trusted", "Powered", "Built", "Made", "Every",
]);

// Name particles glue compound surnames ("de la Cruz", "van der Berg") without counting as separate
// name words — so a real 4-token name isn't rejected as too long. Mirrors decisionMaker.ts (kept
// standalone to avoid an import cycle).
const NAME_PARTICLES = new Set([
  "de", "del", "della", "der", "di", "da", "das", "dos", "du", "la", "le", "van", "von",
  "bin", "ibn", "al", "el", "mac", "mc", "st", "san", "santa", "ten", "ter",
]);

const NON_NAME_LC = new Set([...NON_NAME].map((w) => w.toLowerCase()));

function looksLikeName(s: string): boolean {
  const parts = s.trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 5) return false;
  const sig = parts.filter((p) => !NAME_PARTICLES.has(p.toLowerCase().replace(/[.'’-].*$/, "")));
  if (sig.length < 2 || sig.length > 4) return false;
  if (parts.some((p) => NON_NAME_LC.has(p.toLowerCase().replace(/[.'’-].*$/, "")))) return false;
  if (sig.some((p) => p.length < 2 || p === p.toUpperCase())) return false;
  return true;
}

const TITLE_KEYWORD =
  /\b(chief|c[tefoma]o|cro|cpo|chro|vp|vice president|head|director|manager|lead|president|founder|partner|principal|officer|owner)\b/i;

function clean(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#39;|&#x27;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

function pickStr(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return clean(v);
  }
  return "";
}

/** Fields that only ever hold a PERSON's name. */
const NAME_ONLY_KEYS = ["full_name", "fullName", "name", "display_name", "displayName"];
/** `title` is ambiguous — a job title on a person record, a result line on a SERP record. */
const NAME_KEYS = [...NAME_ONLY_KEYS, "title"];
const TITLE_KEYS = ["headline", "job_title", "jobTitle", "occupation", "sub_title", "subtitle", "position", "summary"];
const COMPANY_KEYS = ["company", "company_name", "companyName", "current_company", "currentCompany", "employer", "organization", "org"];

/* ------------------------------------------------------------------ */
/* COMPANY AFFINITY — the guard that keeps this rung honest             */
/* ------------------------------------------------------------------ */

/**
 * THE FAILURE THIS PREVENTS (measured against the live listing 2026-08-07): these people-search
 * APIs take one keyword string and return loose matches with NO binding to the company you asked
 * about. Searching "VP of Marketing Carta" returned an SVP at PriceSmart; "Director of Operations
 * Gusto" returned a manager at a restaurant called "gusto! fresh bowls & wraps". The old extractor
 * accepted both — it validated only that the name parsed as a name and the title contained a
 * leadership word — so the rung would have written a REAL person's name into a curated row for a
 * company they have never worked at, and cold email would have gone out addressing them as that
 * company's decision-maker. A wrong name is far worse than no name.
 *
 * So a candidate is now kept only when the response itself ties them to the target company: their
 * employer/company field, or their headline, has to actually mention it. Anything unverifiable is
 * dropped, which is why this rung can be enabled without it inventing decision-makers.
 */
const LEGAL_SUFFIX = /\b(inc|llc|l\.?l\.?c|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|sa|nv|bv|ab|oy|pty|holdings|group|technologies|technology|labs|software|solutions|systems|services|partners|ventures)\b/g;

function norm(s: string): string {
  return s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** The distinctive part of a company name — legal suffixes and filler stripped. */
function companyCore(company: string): string {
  const stripped = norm(company).replace(LEGAL_SUFFIX, " ").replace(/\s+/g, " ").trim();
  return stripped || norm(company);
}

/** Where a headline stops describing the job and starts naming the employer. */
const SEGMENT = /\s+at\s+|\s*@\s*|\s*[|·–—]\s*|\s+-\s+|\s*,\s*/i;

/**
 * True when `hay` — an employer field, a headline, or a SERP line — says this person works AT the
 * target company, as opposed to merely containing its name somewhere.
 *
 * The distinction is the whole point, and CONTAINMENT IS NOT ENOUGH: "Director of Operations at
 * gusto! fresh bowls & wraps" contains "gusto" but is a restaurant, not Gusto the payroll company.
 * So the haystack is split into segments and the company core must EQUAL a whole segment — the
 * restaurant's segment normalizes to "gusto fresh bowls and wraps" and is rejected, while
 * "… at Gusto", "… @ Gusto" and "… at Stripe, Inc." all reduce to a segment that equals the core.
 * Testing every segment (not just the last) keeps trailing noise like "| We're hiring!" harmless.
 */
function worksAtCompany(hay: string, company: string): boolean {
  const core = companyCore(company);
  if (core.length < 3) return false;   // too short/generic to verify — never guess
  return hay.split(SEGMENT).some((seg) => companyCore(seg) === core);
}

/**
 * Tolerant extraction: walk the whole JSON response and pull validated {name, title} pairs out of
 * BOTH structured person objects (name + headline fields) AND SERP-style title strings
 * ("Jane Doe - VP Engineering - Acme"). Validates names (looksLikeName) and requires a real
 * leadership title so non-people rows can't pose as a decision-maker.
 */
/** Exported for the regression suite (test-paid-naming-affinity.mts) - the guard below is the
 *  only thing standing between a loose keyword search and a fabricated decision-maker. */
export function extractPeople(data: unknown, company: string): PersonCandidate[] {
  const out: PersonCandidate[] = [];
  const seen = new Set<string>();

  const add = (name: string, title: string, employer = "") => {
    if (!looksLikeName(name)) return;
    if (!title || !TITLE_KEYWORD.test(title)) return; // no title, or not a leadership one
    // Company affinity: the response must tie this person to the company we asked about. An
    // untied match is a stranger with a similar-sounding job — see worksAtCompany above.
    if (!worksAtCompany(employer, company) && !worksAtCompany(title, company)) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const split = splitFullName(name);
    out.push({
      fullName: name, firstName: split.firstName, lastName: split.lastName,
      title: title || undefined, headline: title || undefined, source: "rapid_naming", companyName: company,
    } as PersonCandidate);
  };

  const fromSerpTitle = (raw: string) => {
    const parts = raw.split(/\s+[–\-|]\s+/);
    if (parts.length < 2) return;
    // The whole line is the affinity haystack: a SERP result carries the employer in its tail
    // ("Jane Doe - VP Engineering - Acme"), which is exactly the part we must verify against.
    add(parts[0].trim(), parts[1].replace(/\s*\|\s*linkedin.*$/i, "").trim(), raw);
  };

  const visit = (node: unknown) => {
    if (!node || out.length >= 12) return;
    if (Array.isArray(node)) { for (const n of node) visit(n); return; }
    if (typeof node !== "object") return;
    const o = node as Record<string, unknown>;

    // `title` means different things on different records, and reading it wrong silently disables
    // the leadership-title check: on this shape (full_name + title) the LinkedIn listings put the
    // JOB TITLE in `title`, which used to be claimed by NAME_KEYS and never read as a title, so
    // every person came through with an empty title and no check could reject them. When a
    // dedicated name field is present, `title` is the job title.
    const dedicatedName = pickStr(o, NAME_ONLY_KEYS);
    const name = dedicatedName || pickStr(o, ["title"]);
    const title = pickStr(o, TITLE_KEYS) || (dedicatedName ? pickStr(o, ["title"]) : "");
    const employer = pickStr(o, COMPANY_KEYS);
    if (name && looksLikeName(name)) {
      add(name, title, employer);
    } else if (name && / [–\-|] /.test(name)) {
      // a `title`/`name` field that is actually a SERP result line
      fromSerpTitle(name);
    }
    // Recurse into nested containers (data/results/people/items/etc.)
    for (const v of Object.values(o)) if (v && typeof v === "object") visit(v);
  };

  visit(data);
  return out;
}

/**
 * Find decision-maker name candidates for a company via the configured RapidAPI people-search.
 * Returns [] on any miss/error/timeout, or when not configured. Does NOT use egress rotation — it's
 * an authenticated paid API, so it goes out the default route (rotation is only for the free scrapers).
 */
export async function findDecisionMakerRapid(
  company: string,
  _domain: string | undefined,
  titles: string[],
): Promise<PersonCandidate[]> {
  if (!paidNamingEnabled() || !company) return [];
  const search = `${titles[0] || ""} ${company}`.trim();
  const host = cfg.host();
  const headers: Record<string, string> = {
    "X-RapidAPI-Key": process.env.RAPID_NAMING_KEY!,
    "X-RapidAPI-Host": host,
    Accept: "application/json",
  };

  try {
    let res: Response;
    if (cfg.method() === "GET") {
      const u = new URL(`https://${host}${cfg.path()}`);
      u.searchParams.set(cfg.queryParam(), search);
      if (cfg.companyParam()) u.searchParams.set(cfg.companyParam(), company);
      res = await fetch(u.toString(), { method: "GET", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } else {
      const body: Record<string, unknown> = { [cfg.queryParam()]: search };
      if (cfg.companyParam()) body[cfg.companyParam()] = company;
      res = await fetch(`https://${host}${cfg.path()}`, {
        method: cfg.method(),
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    }
    if (!res.ok) return [];
    const data: unknown = await res.json().catch(() => null);
    return data ? extractPeople(data, company) : [];
  } catch {
    return [];
  }
}
