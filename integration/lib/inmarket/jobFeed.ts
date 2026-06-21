/**
 * RecruitersOS · In-Market · Paid JOB-FEED connector (Active Jobs DB / RapidAPI-style)
 *
 * The free sources cap the pool at ~hundreds of companies (the keyless boards + a ~250-slug ATS
 * directory). This connector breaks that ceiling: it pulls REAL ATS job postings (Greenhouse / Lever /
 * Ashby / Paylocity / SmartRecruiters / …) by category + US location from a paid feed, normalizes each
 * into an InMarketLead, and ships them to the pool — where the SAME enrichment fleet (domain → name →
 * email) turns them into contacts. Build = sourcing; the contact-finding you already have is unchanged.
 *
 * ENV-GATED + PROVIDER-AGNOSTIC (returns [] = no-op, zero spend, until configured):
 *   RAPID_JOBS_KEY             (required) your RapidAPI X-RapidAPI-Key — enables the feed
 *   RAPID_JOBS_HOST            (required) the X-RapidAPI-Host, e.g. "active-jobs-db.p.rapidapi.com"
 *   RAPID_JOBS_PATH            default "/active-ats-7d"
 *   RAPID_JOBS_TITLE_PARAM     default "title_filter"     (the category/role keyword param)
 *   RAPID_JOBS_LOCATION_PARAM  default "location_filter"
 *   RAPID_JOBS_LIMIT_PARAM     default "limit"
 *   RAPID_JOBS_OFFSET_PARAM    default "offset"
 *
 * US-ONLY at the door (the feed returns global rows; we keep only United States), never throws.
 */

import type { InMarketLead } from "./index";

const TIMEOUT_MS = 60_000; // this feed can be slow — allow up to a minute
const MAX_ROLES_PER_COMPANY = 25;

export function jobFeedEnabled(): boolean {
  return !!process.env.RAPID_JOBS_KEY && !!process.env.RAPID_JOBS_HOST;
}

const cfg = {
  host: () => process.env.RAPID_JOBS_HOST || "",
  path: () => process.env.RAPID_JOBS_PATH || "/active-ats-7d",
  titleParam: () => process.env.RAPID_JOBS_TITLE_PARAM || "title_filter",
  locationParam: () => process.env.RAPID_JOBS_LOCATION_PARAM || "location_filter",
  limitParam: () => process.env.RAPID_JOBS_LIMIT_PARAM || "limit",
  offsetParam: () => process.env.RAPID_JOBS_OFFSET_PARAM || "offset",
};

/** One raw record from the feed (Active Jobs DB shape; optional everywhere — we read defensively). */
interface RawJob {
  id?: string;
  title?: string;
  organization?: string;
  organization_url?: string | null;
  url?: string;
  date_posted?: string;
  source?: string;
  source_domain?: string;
  countries_derived?: string[] | null;
  locations_derived?: string[] | null;
  cities_derived?: string[] | null;
  regions_derived?: string[] | null;
}

function isUS(j: RawJob): boolean {
  const c = j.countries_derived;
  return Array.isArray(c) && c.some((x) => /united states|^usa?$/i.test(String(x).trim()));
}

function locationOf(j: RawJob): string {
  return (
    j.locations_derived?.[0] ||
    [j.cities_derived?.[0], j.regions_derived?.[0]].filter(Boolean).join(", ") ||
    "United States"
  );
}

function companyId(company: string): string {
  return `jobfeed_${company.toLowerCase().replace(/[^a-z0-9]+/g, "")}`.slice(0, 120);
}

/**
 * Fetch one page of the feed and normalize to InMarketLeads — GROUPED BY COMPANY so a company hiring
 * several roles becomes one lead with a hiring-velocity score (more open roles → higher intent).
 */
export async function fetchJobFeedLeads(opts: { title?: string; location?: string; limit?: number; offset?: number }): Promise<InMarketLead[]> {
  if (!jobFeedEnabled()) return [];
  const host = cfg.host();
  const u = new URL(`https://${host}${cfg.path()}`);
  if (opts.title) u.searchParams.set(cfg.titleParam(), opts.title);
  u.searchParams.set(cfg.locationParam(), opts.location || "United States");
  u.searchParams.set(cfg.limitParam(), String(Math.min(Math.max(opts.limit ?? 100, 1), 1000)));
  if (opts.offset) u.searchParams.set(cfg.offsetParam(), String(opts.offset));

  let arr: RawJob[] = [];
  try {
    const res = await fetch(u.toString(), {
      headers: { "X-RapidAPI-Key": process.env.RAPID_JOBS_KEY!, "X-RapidAPI-Host": host, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => null)) as unknown;
    arr = Array.isArray(data)
      ? (data as RawJob[])
      : (((data as { jobs?: RawJob[]; data?: RawJob[]; results?: RawJob[] })?.jobs ||
          (data as { data?: RawJob[] })?.data ||
          (data as { results?: RawJob[] })?.results) ?? []);
  } catch {
    return [];
  }
  return mapJobsToLeads(arr, opts.title);
}

/**
 * PURE normalizer (no network) — US-filter + group-by-company + hiring-velocity score. Exported so the
 * mapping can be unit-tested against a real sample without a key.
 */
export function mapJobsToLeads(arr: RawJob[], category?: string): InMarketLead[] {
  const byCompany = new Map<string, { company: string; location: string; roles: Array<{ title: string; postedAt?: string; location?: string; url?: string }> }>();
  for (const j of arr) {
    if (!isUS(j)) continue;                                   // US-only at the door
    const company = (j.organization || "").trim();
    const title = (j.title || "").trim();
    if (company.length < 2 || !title) continue;
    const key = company.toLowerCase();
    const loc = locationOf(j);
    const e = byCompany.get(key) ?? { company, location: loc, roles: [] };
    if (e.roles.length < MAX_ROLES_PER_COMPANY) e.roles.push({ title, postedAt: j.date_posted, location: loc, url: j.url });
    byCompany.set(key, e);
  }

  const out: InMarketLead[] = [];
  for (const e of byCompany.values()) {
    const n = e.roles.length;
    // Hiring-velocity score: a company posting many roles is a hotter signal. 55 base, +4/extra role, cap 90.
    const score = Math.min(90, 55 + (n - 1) * 4);
    out.push({
      id: companyId(e.company),
      company: e.company,
      location: e.location,
      reason: n > 1 ? `Hiring ${n} roles (incl. "${e.roles[0].title}")` : `Hiring: ${e.roles[0].title}`,
      signalType: n > 1 ? "hiring_velocity" : "job_posting",
      score,
      scoreReasons: [`${n} open role${n > 1 ? "s" : ""} on a public ATS`, ...(category ? [`Category: ${category}`] : [])],
      roles: e.roles.map((r) => r.title),
      roleDetails: e.roles,
    });
  }
  return out;
}

/**
 * Pull a page from the feed and merge it into the shared pool. Returns how many company-leads were
 * shipped (0 when not configured). The accumulator calls this each cycle (gated by the key).
 */
export async function runJobFeedSourcing(opts: { title?: string; location?: string; limit?: number; offset?: number }): Promise<number> {
  if (!jobFeedEnabled()) return 0;
  const leads = await fetchJobFeedLeads(opts);
  if (!leads.length) return 0;
  const { mergeIntoPool } = await import("./pool");
  await mergeIntoPool(leads);
  return leads.length;
}
