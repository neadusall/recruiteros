/**
 * RecruitersOS · In-Market · Paid JOB-FEED connector (JSearch primary, Active Jobs DB compatible)
 *
 * The free sources cap the pool at ~hundreds of companies. This connector breaks that ceiling: it pulls
 * REAL job postings by category + US from a paid RapidAPI feed, normalizes each into an InMarketLead,
 * and ships them to the pool — where the SAME enrichment fleet (domain → name → email) turns them into
 * contacts. Build = sourcing; the contact-finding you already have is unchanged.
 *
 * VERIFIED LIVE (JSearch, Jun 2026): per-REQUEST billing, ~10 jobs/request, country=us filters to US,
 * and each record carries `employer_website` → we get the company DOMAIN for free (skip resolution).
 *
 * ENV-GATED + PROVIDER-AGNOSTIC (returns [] = no-op, zero spend, until configured):
 *   RAPID_JOBS_KEY        (required) your RapidAPI X-RapidAPI-Key
 *   RAPID_JOBS_HOST       (required) e.g. "jsearch.p.rapidapi.com"
 *   RAPID_JOBS_PROVIDER   "jsearch" (default) | "active-jobs-db"
 *   RAPID_JOBS_DATE       JSearch date_posted window — default "week"
 */

import type { InMarketLead } from "./index";

const TIMEOUT_MS = 30_000;
const MAX_ROLES_PER_COMPANY = 25;
const JOBS_PER_PAGE = 10; // JSearch returns ~10 jobs per page/request

export function jobFeedEnabled(): boolean {
  return !!process.env.RAPID_JOBS_KEY && !!process.env.RAPID_JOBS_HOST;
}
const PROVIDER = (): string => (process.env.RAPID_JOBS_PROVIDER || "jsearch").toLowerCase();

/** Defensive raw record — superset of JSearch + Active Jobs DB field names. */
interface RawJob {
  // JSearch
  employer_name?: string; employer_website?: string | null; job_title?: string; job_apply_link?: string;
  apply_options?: Array<{ publisher?: string; apply_link?: string; is_direct?: boolean }> | null;
  job_country?: string; job_city?: string; job_state?: string; job_posted_at_datetime_utc?: string; industry?: string;
  // Active Jobs DB
  organization?: string; organization_url?: string | null; title?: string; url?: string; date_posted?: string;
  countries_derived?: string[] | null; locations_derived?: string[] | null; cities_derived?: string[] | null; regions_derived?: string[] | null;
}

function field(j: RawJob, ...keys: (keyof RawJob)[]): string {
  for (const k of keys) { const v = j[k]; if (typeof v === "string" && v.trim()) return v.trim(); }
  return "";
}
function isUS(j: RawJob): boolean {
  if (typeof j.job_country === "string") return /^us$|united states/i.test(j.job_country.trim());
  const c = j.countries_derived;
  return Array.isArray(c) && c.some((x) => /united states|^usa?$/i.test(String(x).trim()));
}
function locationOf(j: RawJob): string {
  if (j.job_city || j.job_state) return `${[j.job_city, j.job_state].filter(Boolean).join(", ")}, United States`;
  return j.locations_derived?.[0] || [j.cities_derived?.[0], j.regions_derived?.[0]].filter(Boolean).join(", ") || "United States";
}
/** Company domain straight off the job record (JSearch employer_website) — saves a resolution step. */
function domainOf(j: RawJob): string | undefined {
  const w = field(j, "employer_website", "organization_url");
  if (!w) return undefined;
  try {
    const h = new URL(w.startsWith("http") ? w : `https://${w}`).hostname.replace(/^www\./, "").toLowerCase();
    return h.includes(".") ? h : undefined;
  } catch { return undefined; }
}
function companyId(company: string): string {
  return `jobfeed_${company.toLowerCase().replace(/[^a-z0-9]+/g, "")}`.slice(0, 120);
}

/** Hosts that bot-wall a headless capture — roleShot can't screenshot these, so don't feed them. */
const AGG_RE = /(^|\.)(linkedin|indeed|glassdoor|ziprecruiter|monster|dice|simplyhired|jooble|adzuna|lensa|talent\.com)\./i;
/** Press / marketing / investor paths — we must screenshot a JOB DESCRIPTION, never a press release,
 *  blog, news, or "about" page. A URL whose path looks like PR/marketing is rejected as a capture
 *  target so the screenshot is always of an actual job post (belt-and-suspenders with roleShot's own
 *  JD verification, which is the hard gate). */
const PR_PATH_RE = /\/(press|news|newsroom|media|investors?|press-?releases?|announcements?|blog|articles?|stories|insights|events)(\/|\?|#|$)/i;
/** Recognizable ATS / job-posting URL shapes — a strong signal the page is an actual job description.
 *  Prefer a candidate that matches one of these over a bare company URL. */
const JOB_URL_RE = /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|bamboohr\.com|jobvite\.com|icims\.com|myworkdayjobs\.com|workday|taleo|breezy\.hr|jazzhr|teamtailor)|\/(jobs?|careers?|job|posting|openings?|positions?|opportunit(?:y|ies)|vacanc(?:y|ies))(\/|\?|#|$)/i;
function hostOfUrl(u: string): string {
  try { return new URL(u).hostname; } catch { return ""; }
}
/** Pick the best posting URL to hand roleShot. JSearch's primary `job_apply_link` is a
 *  LinkedIn/aggregator URL ~half the time (those bot-wall, so they can't be captured). The
 *  `apply_options` array usually also carries a DIRECT company/ATS link — prefer that. We also
 *  refuse press-release / blog / investor URLs so the screenshot is always a real JOB DESCRIPTION,
 *  never a PR page (per the user's requirement). */
function bestApplyUrl(j: RawJob): string | undefined {
  const links = (Array.isArray(j.apply_options) ? j.apply_options : [])
    .map((o) => (typeof o?.apply_link === "string" ? { url: o.apply_link.trim(), direct: !!o.is_direct } : null))
    .filter((x): x is { url: string; direct: boolean } => !!x && /^https?:\/\//.test(x.url));
  const primary = field(j, "job_apply_link", "url");
  if (/^https?:\/\//.test(primary)) links.push({ url: primary, direct: false });
  // Drop aggregators (bot-walled, not the company's own posting) and PR/marketing pages (not a job).
  const clean = links.filter((l) => !AGG_RE.test(hostOfUrl(l.url)) && !PR_PATH_RE.test(l.url));
  // Prefer a URL that LOOKS like a real job posting (ATS host / careers path), direct first, then any
  // clean URL, direct first. If nothing clean remains, return undefined — roleShot will fall back to
  // verified careers-page discovery rather than screenshot an aggregator/PR page.
  const jobShaped = clean.filter((l) => JOB_URL_RE.test(l.url));
  const pick = jobShaped.find((l) => l.direct) ?? jobShaped[0] ?? clean.find((l) => l.direct) ?? clean[0];
  return pick?.url || undefined;
}

/** PURE normalizer (no network) — US-filter + group-by-company + hiring-velocity score + domain capture. */
export function mapJobsToLeads(arr: RawJob[], category?: string): InMarketLead[] {
  const byCompany = new Map<string, { company: string; location: string; domain?: string; roles: Array<{ title: string; postedAt?: string; location?: string; url?: string }> }>();
  for (const j of arr) {
    if (!isUS(j)) continue;
    const company = field(j, "employer_name", "organization");
    const title = field(j, "job_title", "title");
    if (company.length < 2 || !title) continue;
    const key = company.toLowerCase();
    const e = byCompany.get(key) ?? { company, location: locationOf(j), domain: domainOf(j), roles: [] };
    if (!e.domain) e.domain = domainOf(j);
    if (e.roles.length < MAX_ROLES_PER_COMPANY) {
      e.roles.push({ title, postedAt: field(j, "job_posted_at_datetime_utc", "date_posted") || undefined, location: locationOf(j), url: bestApplyUrl(j) });
    }
    byCompany.set(key, e);
  }
  const out: InMarketLead[] = [];
  for (const e of byCompany.values()) {
    const n = e.roles.length;
    const score = Math.min(90, 55 + (n - 1) * 4); // hiring velocity: more roles → hotter
    out.push({
      id: companyId(e.company),
      company: e.company,
      domain: e.domain,
      location: e.location,
      sourceUrl: e.roles[0]?.url, // the posting link → feeds roleShot to find+screenshot the company-site job
      reason: n > 1 ? `Hiring ${n} roles (incl. "${e.roles[0].title}")` : `Hiring: ${e.roles[0].title}`,
      signalType: n > 1 ? "hiring_velocity" : "job_posting",
      score,
      scoreReasons: [`${n} open role${n > 1 ? "s" : ""}`, ...(category ? [`Category: ${category}`] : [])],
      roles: e.roles.map((r) => r.title),
      roleDetails: e.roles,
    });
  }
  return out;
}

/** A targeted JSearch query. `query` (role/keywords) is required by JSearch; the rest narrow it so
 *  the USER drives exactly what gets scraped (vs. the old random rotation). */
export interface JobFeedOpts {
  query?: string;
  location?: string;                 // folded into the JSearch query as "<query> in <location>"
  datePosted?: string;               // JSearch date_posted: all | today | 3days | week | month
  employmentTypes?: string[];        // JSearch employment_types: FULLTIME | PARTTIME | CONTRACTOR | INTERN
  remoteOnly?: boolean;              // JSearch remote_jobs_only
  limit?: number;                    // jobs to pull
  offset?: number;                   // page-block offset (in jobs) for deeper pagination
}

/** Fetch one page-set from the feed and normalize. `limit` is in JOBS; for JSearch we convert to pages. */
export async function fetchJobFeedLeads(opts: JobFeedOpts): Promise<InMarketLead[]> {
  if (!jobFeedEnabled()) return [];
  const host = process.env.RAPID_JOBS_HOST!;
  const isJSearch = PROVIDER() === "jsearch";
  // JSearch's search endpoint is `/search-v2` (the legacy `/search` now 404s at the RapidAPI gateway).
  const u = new URL(`https://${host}${process.env.RAPID_JOBS_PATH || (isJSearch ? "/search-v2" : "/active-ats")}`);

  if (isJSearch) {
    // Build the query from role/keywords + (optional) location. JSearch's /search has no separate
    // location param — "<role> in <place>" is its native shape — so fold location into the query
    // unless it's a nationwide pass or the caller already embedded an "in <place>" clause.
    let q = (opts.query || "hiring").trim();
    const loc = (opts.location || "").trim();
    if (loc && !/^united states$/i.test(loc) && !/\bin\s+\S/i.test(q)) q = `${q} in ${loc}`;
    u.searchParams.set("query", q);                             // JSearch requires a query (role/keywords)
    u.searchParams.set("country", "us");
    u.searchParams.set("date_posted", opts.datePosted || process.env.RAPID_JOBS_DATE || "week");
    if (opts.remoteOnly) u.searchParams.set("remote_jobs_only", "true");
    if (Array.isArray(opts.employmentTypes) && opts.employmentTypes.length) {
      u.searchParams.set("employment_types", opts.employmentTypes.join(","));
    }
    const pages = Math.min(Math.max(Math.ceil((opts.limit ?? JOBS_PER_PAGE) / JOBS_PER_PAGE), 1), 20);
    u.searchParams.set("num_pages", String(pages));
    u.searchParams.set("page", String(opts.offset ? Math.floor(opts.offset / JOBS_PER_PAGE) + 1 : 1));
  } else {
    u.searchParams.set("time_frame", process.env.RAPID_JOBS_TIME_FRAME || "7d");
    if (opts.query) u.searchParams.set(process.env.RAPID_JOBS_TITLE_PARAM || "title_filter", opts.query);
    u.searchParams.set(process.env.RAPID_JOBS_LIMIT_PARAM || "limit", String(Math.min(Math.max(opts.limit ?? 100, 1), 1000)));
    if (opts.offset) u.searchParams.set(process.env.RAPID_JOBS_OFFSET_PARAM || "offset", String(opts.offset));
  }

  let arr: RawJob[] = [];
  try {
    const res = await fetch(u.toString(), { headers: { "X-RapidAPI-Key": process.env.RAPID_JOBS_KEY!, "X-RapidAPI-Host": host, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => null)) as unknown;
    // Normalize across shapes: flat array, JSearch v2 `{data:{jobs:[…]}}`, legacy
    // `{data:[…]}`, and `{jobs:[…]}`. v2 nests under data.jobs, so check it first.
    const root = data as { data?: { jobs?: RawJob[] } | RawJob[]; jobs?: RawJob[] } | RawJob[] | null;
    arr = Array.isArray(root) ? (root as RawJob[])
      : Array.isArray((root as { data?: { jobs?: RawJob[] } })?.data?.jobs) ? (root as { data: { jobs: RawJob[] } }).data.jobs
      : Array.isArray((root as { data?: RawJob[] })?.data) ? (root as { data: RawJob[] }).data
      : Array.isArray((root as { jobs?: RawJob[] })?.jobs) ? (root as { jobs: RawJob[] }).jobs
      : [];
  } catch { return []; }
  return mapJobsToLeads(arr, opts.query);
}

/** PREVIEW a targeted search WITHOUT touching the pool — fetch + normalize and report the companies
 *  found (+ total open roles) so the user can pick which to actually scrape. This is the "I decide
 *  which jobs we scrape" step: nothing merges until the user commits the selected leads. */
export async function previewJobFeed(opts: JobFeedOpts): Promise<{ leads: InMarketLead[]; companies: number; jobs: number }> {
  const leads = await fetchJobFeedLeads(opts);
  const jobs = leads.reduce((s, l) => s + (l.roleDetails?.length || l.roles?.length || 1), 0);
  return { leads, companies: leads.length, jobs };
}

/** Pull from the feed and merge into the pool. Returns company-leads shipped (0 when not configured). */
export async function runJobFeedSourcing(opts: JobFeedOpts): Promise<number> {
  if (!jobFeedEnabled()) return 0;
  const leads = await fetchJobFeedLeads(opts);
  if (!leads.length) return 0;
  const { mergeIntoPool } = await import("./pool");
  await mergeIntoPool(leads);
  return leads.length;
}
