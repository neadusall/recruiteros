/**
 * RecruitersOS · Size-gated decision-maker list builder (Fresh LinkedIn Scraper)
 *
 * Goal: a large list of the PEOPLE that matter — VP/Director decision-makers — at US
 * companies sized 100-5,000 employees, with the company fields on every row (company name,
 * HQ location, company URL, headcount). The size band is a HARD filter, enforced per
 * company against real LinkedIn employee counts.
 *
 * THE FUNNEL (derived from live probes of fresh-linkedin-scraper-api.p.rapidapi.com)
 * --------------------------------------------------------------------------------
 * That listing has no company-search-by-size and no title filter on company/people, so the
 * only title-targeted, size-aware path is:
 *
 *   1. people-search      GET /api/v1/search/people?name=<title>&geocode_location=<US>&page=
 *        → 10 title-matched people/request: full_name, title ("VP of Sales @ Uplinq"),
 *          location, profile url. The company NAME rides in the title line.
 *   2. extract company    parse the employer out of the title.
 *   3. company/profile    GET /api/v1/company/profile?company=<name>   (CACHED per company)
 *        → real employee_count + range, website_url, linkedin_url, headquarter (city/state).
 *        → GATE: keep the person only when 100 ≤ employee_count ≤ 5,000.
 *   4. email permutation  free, local: first.last@<website-domain> etc. — kept as a
 *        "potential" email with every candidate stashed for downstream validation.
 *   5. upsert into the Data warehouse with the full field set.
 *
 * COST SHAPE: 1 request per 10 candidates (search) + 1 request per UNIQUE company (profile).
 * The profile gate is the request cost — most VP/Directors sit at distinct companies and
 * ~2/3 fall outside the band — so a strict, all-fields, size-verified list trades volume for
 * precision. The company-profile cache makes repeat employers free, lifting yield over a run.
 *
 * Resumable: a persisted cursor over the (title × geo) segments + the page within the
 * current segment, plus the company-profile cache, all driven by repeated bounded steps.
 */

import { upsertRecords } from "../data/store";
import type { DataRecordInput } from "../data/types";
import { loadSnapshot, saveSnapshot } from "../db";
import { rid, nowIso } from "../core/ids";
import { cred } from "../providers/http";
import { DECISION_MAKER_TITLES, US_GEOS } from "./bulkList";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const RAPIDAPI_KEY = () => cred("RAPIDAPI_KEY");
const HOST = () => cred("RAPIDAPI_PEOPLE_SEARCH_HOST");
const PEOPLE_PATH = () => cred("RAPIDAPI_PEOPLE_SEARCH_PATH") || "/api/v1/search/people";
const COMPANY_PROFILE_PATH = () => cred("RAPIDAPI_COMPANY_PROFILE_PATH") || "/api/v1/company/profile";
const US_GEOCODE = () => cred("RAPIDAPI_US_GEOCODE") || "103644278";

export function companyFirstConfigured(): boolean {
  return Boolean(RAPIDAPI_KEY() && HOST());
}

/** The headcount window we accept (employees). */
const MIN_EMPLOYEES = 100;
const MAX_EMPLOYEES = 5000;

/** Confirm the searched person is actually a VP/Director-level decision-maker. */
const DECISION_MAKER_RE = /\b(vp|v\.p\.|vice\s+president|director|head\s+of|chief|c[teofmiar]o)\b/i;

/* ------------------------------------------------------------------ */
/* HTTP + parsing                                                      */
/* ------------------------------------------------------------------ */

async function rapidGet(path: string): Promise<any> {
  const host = HOST();
  const res = await fetch(`https://${host}${path}`, {
    headers: { "X-RapidAPI-Key": RAPIDAPI_KEY(), "X-RapidAPI-Host": host, Accept: "application/json" },
  });
  if (!res.ok && res.status !== 202) throw new Error(`rapidapi ${host} ${res.status}`);
  const data = await res.json().catch(() => ({}));
  return data;
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s || undefined;
}

interface PersonHit { fullName: string; title?: string; location?: string; url?: string }

function mapPerson(o: any): PersonHit | null {
  if (!o || typeof o !== "object") return null;
  const fullName = str(o.full_name) || str(o.fullName) || str(o.name);
  if (!fullName || /^linkedin member$/i.test(fullName)) return null;
  let url = str(o.url) || str(o.profile_url) || str(o.linkedin_url);
  if (url) url = url.split("?")[0];
  return { fullName, title: str(o.title) || str(o.headline), location: str(o.location), url };
}

/** Pull the employer out of a LinkedIn headline: "VP of Sales @ Uplinq", "Director at Acme",
 *  "VP Sales | Acme Corp". Returns a clean-ish company name to resolve, or undefined. */
export function companyFromTitle(title?: string): string | undefined {
  if (!title) return undefined;
  // Prefer an explicit employer separator.
  const m = title.match(/\s(?:@|at)\s+(.+)$/i);
  let co = m ? m[1] : undefined;
  if (!co) {
    // Fall back to a " | " / " · " segment that isn't the role itself.
    const parts = title.split(/\s*[|·•]\s*/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) co = parts[1];
  }
  if (!co) return undefined;
  // Trim trailing noise after the company token ("Acme | CSE '25", "Acme · 50K+ followers").
  co = co.split(/\s*[|·•]\s*/)[0].trim();
  co = co.replace(/\s*[-–—]\s.*$/, "").trim();          // "Acme - we hire" → "Acme"
  co = co.replace(/\b(inc|llc|ltd|corp|co)\.?$/i, "").trim();
  return co || undefined;
}

interface CompanyProfile {
  name?: string;
  employees?: number;
  rangeStart?: number;
  rangeEnd?: number;
  website?: string;
  domain?: string;
  linkedinUrl?: string;
  hq?: string;
}

/** Shorteners / redirect / marketing hosts that aren't the company's email domain. */
const JUNK_DOMAIN_RE = /^(bit\.ly|lnkd\.in|goo\.gle|ow\.ly|t\.co|hubs\.(li|ly)|rebrand\.ly|trk\.|click\.)|^(link|go|get|info|careers|jobs|hub)\./i;

/** Reduce a website_url to a usable EMAIL domain, or undefined when it's a redirect/shortener
 *  (in which case the caller lets the waterfall guess the domain from the company name). */
function cleanDomain(website?: string): string | undefined {
  if (!website) return undefined;
  let host = website.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase().trim();
  if (!host || !host.includes(".")) return undefined;
  if (JUNK_DOMAIN_RE.test(host)) return undefined;           // shortener → guess from name instead
  host = host.replace(/^(link|go|get|info|careers|jobs|hub|email)\./, ""); // strip marketing subdomain
  return host || undefined;
}

function parseProfile(data: any): CompanyProfile | null {
  const d = data?.data ?? data;
  if (!d || typeof d !== "object" || d.success === false) return null;
  const emp = typeof d.employee_count === "number" ? d.employee_count : undefined;
  const range = d.employee_count_range || {};
  const website = str(d.website_url) || str(d.website);
  const domain = cleanDomain(website);
  const hqObj = d.headquarter || d.headquarters || {};
  const hq = [str(hqObj.city), str(hqObj.geographic_area) || str(hqObj.country)].filter(Boolean).join(", ") || undefined;
  return {
    name: str(d.name),
    employees: emp,
    rangeStart: typeof range.start === "number" ? range.start : undefined,
    rangeEnd: typeof range.end === "number" ? range.end : undefined,
    website,
    domain,
    linkedinUrl: str(d.linkedin_url),
    hq,
  };
}

async function searchPeople(title: string, geocode: string, page: number): Promise<PersonHit[]> {
  const params = new URLSearchParams({ name: title, geocode_location: geocode, page: String(page) });
  const data = await rapidGet(`${PEOPLE_PATH()}?${params.toString()}`);
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return list.map(mapPerson).filter((p: PersonHit | null): p is PersonHit => Boolean(p));
}

async function companyProfile(name: string): Promise<CompanyProfile | null> {
  const data = await rapidGet(`${COMPANY_PROFILE_PATH()}?company=${encodeURIComponent(name)}`);
  return parseProfile(data);
}

/** True when a resolved profile's headcount sits inside the accepted band. */
function inBand(p: CompanyProfile): boolean {
  if (typeof p.employees === "number") return p.employees >= MIN_EMPLOYEES && p.employees <= MAX_EMPLOYEES;
  // No exact count — fall back to the range midpoint if present.
  if (typeof p.rangeStart === "number") {
    const mid = typeof p.rangeEnd === "number" ? (p.rangeStart + p.rangeEnd) / 2 : p.rangeStart;
    return mid >= MIN_EMPLOYEES && mid <= MAX_EMPLOYEES;
  }
  return false;
}

function bandLabel(p: CompanyProfile): string {
  const n = p.employees;
  if (typeof n !== "number") return p.rangeStart ? `${p.rangeStart}-${p.rangeEnd ?? ""}` : "";
  if (n <= 200) return "51-200";
  if (n <= 500) return "201-500";
  if (n <= 1000) return "501-1000";
  return "1001-5000";
}

/* ------------------------------------------------------------------ */
/* Job state (persisted, resumable)                                    */
/* ------------------------------------------------------------------ */

interface Segment { title: string; geo: string }

export interface CompanyFirstJob {
  id: string;
  workspaceId: string;
  status: "running" | "paused" | "done";
  target: number;
  requireEmail: boolean;
  segments: Segment[];
  cursor: number;
  page: number;
  /** Resolved company-profile cache (name → profile or null when not found / out of band),
   *  so a repeat employer never costs a second profile request. */
  companyCache: Record<string, CompanyProfile | null>;
  /** Tallies. */
  collected: number;
  peopleScanned: number;
  companiesProfiled: number;
  inBandCompanies: number;
  requestsUsed: number;
  seenPeople: string[];
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

const jobKey = (ws: string) => `company_first_job_v1:${ws}`;

export async function companyFirstStatus(ws: string): Promise<CompanyFirstJob | null> {
  return (await loadSnapshot<CompanyFirstJob>(jobKey(ws))) ?? null;
}

async function persist(job: CompanyFirstJob): Promise<void> {
  job.updatedAt = nowIso();
  await saveSnapshot(jobKey(job.workspaceId), job);
}

function buildSegments(titles: string[], geos: string[]): Segment[] {
  const out: Segment[] = [];
  for (const title of titles) for (const geo of geos) out.push({ title, geo });
  return out;
}

export interface StartCompanyFirstOptions {
  target?: number;
  requireEmail?: boolean;
  titles?: string[];
  geos?: string[];
}

export async function startCompanyFirst(ws: string, opts: StartCompanyFirstOptions = {}): Promise<CompanyFirstJob> {
  if (!companyFirstConfigured()) {
    throw new Error("No people-search provider configured. Set RAPIDAPI_KEY + RAPIDAPI_PEOPLE_SEARCH_HOST first.");
  }
  const now = nowIso();
  const job: CompanyFirstJob = {
    id: rid("cofirst"),
    workspaceId: ws,
    status: "running",
    target: Math.max(1, opts.target ?? 100_000),
    requireEmail: opts.requireEmail ?? true,
    segments: buildSegments(opts.titles ?? DECISION_MAKER_TITLES, opts.geos ?? US_GEOS),
    cursor: 0,
    page: 1,
    companyCache: {},
    collected: 0,
    peopleScanned: 0,
    companiesProfiled: 0,
    inBandCompanies: 0,
    requestsUsed: 0,
    seenPeople: [],
    warnings: [],
    createdAt: now,
    updatedAt: now,
  };
  await persist(job);
  return job;
}

/* ------------------------------------------------------------------ */
/* The work step                                                       */
/* ------------------------------------------------------------------ */

function splitName(full: string): { first: string; last: string } {
  const parts = (full || "").trim().split(/\s+/);
  return { first: parts[0] || "", last: parts.length > 1 ? parts[parts.length - 1] : "" };
}
function splitLocation(loc?: string): { city?: string; state?: string } {
  if (!loc) return {};
  const [city, state] = loc.split(",").map((s) => s.trim());
  return { city: city || undefined, state: state || undefined };
}

export interface CompanyFirstStepResult {
  job: CompanyFirstJob;
  added: number;
  requests: number;
  done: boolean;
}

/**
 * Advance the job by up to `maxRequests` RapidAPI calls (people-search + company/profile).
 * Bounded for one serverless invocation; call repeatedly (cron / loop) until `done`.
 */
export async function stepCompanyFirst(ws: string, maxRequests = 8): Promise<CompanyFirstStepResult> {
  const job = await companyFirstStatus(ws);
  if (!job) throw new Error("No company-first job. Start one first.");
  if (job.status === "done" || job.collected >= job.target) {
    job.status = "done"; await persist(job);
    return { job, added: 0, requests: 0, done: true };
  }

  const seen = new Set(job.seenPeople);
  const { enrich, contactWaterfall } = await import("../signals");
  const plan = contactWaterfall(); // free domain-guess + email permutation
  const geocode = US_GEOCODE();

  let added = 0;
  let requests = 0;
  const batch: DataRecordInput[] = [];

  while (requests < maxRequests && job.cursor < job.segments.length && job.collected + added < job.target) {
    const seg = job.segments[job.cursor];
    let people: PersonHit[] = [];
    try {
      people = await searchPeople(seg.title, geocode, job.page);
      requests++; job.requestsUsed++;
    } catch (e: any) {
      job.warnings.push(`people-search ${seg.title}/${seg.geo} p${job.page}: ${(e && e.message) || e}`);
      job.cursor++; job.page = 1; continue;
    }

    // Advance pagination or move to the next segment when it's exhausted.
    if (people.length === 0 || people.length < 10 || job.page >= 100) { job.cursor++; job.page = 1; }
    else job.page++;

    for (const p of people) {
      if (job.collected + added >= job.target) break;
      job.peopleScanned++;
      if (!DECISION_MAKER_RE.test(p.title || "")) continue;
      const pkey = p.url ? "li:" + p.url.toLowerCase().replace(/\/+$/, "") : "nc:" + p.fullName.toLowerCase();
      if (seen.has(pkey)) continue;
      seen.add(pkey);

      const coName = companyFromTitle(p.title);
      if (!coName) continue; // can't determine employer → can't size-gate

      // Resolve (and cache) the company profile — the size gate + company fields.
      let prof = job.companyCache[coName.toLowerCase()];
      if (prof === undefined) {
        if (requests >= maxRequests) break; // out of budget this step; revisit next step
        try {
          prof = await companyProfile(coName);
          requests++; job.requestsUsed++; job.companiesProfiled++;
        } catch (e: any) {
          prof = null;
          job.warnings.push(`profile ${coName}: ${(e && e.message) || e}`);
        }
        job.companyCache[coName.toLowerCase()] = prof;
        if (prof && inBand(prof)) job.inBandCompanies++;
      }
      if (!prof || !inBand(prof)) continue; // OUT of the 100-5,000 band → drop

      // Free email permutation from the company's real domain.
      const { first, last } = splitName(p.fullName);
      let email: string | undefined;
      let permutations: string[] | undefined;
      let domain = prof.domain;
      if (first && last && (prof.domain || prof.name || coName)) {
        try {
          const report = await enrich(
            plan,
            { name: prof.name || coName, companyName: prof.name || coName, domain: prof.domain, fullName: p.fullName, firstName: first, lastName: last, title: p.title },
            { now: nowIso() },
          );
          const dom = report.resolved.domain;
          if (dom && typeof dom.value === "string") domain = dom.value;
          const em = report.resolved.email;
          if (em && typeof em.value === "string") {
            email = em.value;
            const perms = (em.raw as { permutations?: unknown })?.permutations;
            if (Array.isArray(perms)) permutations = perms.filter((x): x is string => typeof x === "string");
          }
        } catch { /* keep row without email */ }
      }
      if (job.requireEmail && !email) continue;

      const { city, state } = splitLocation(p.location);
      batch.push({
        fullName: p.fullName,
        firstName: first || undefined,
        lastName: last || undefined,
        title: p.title,
        seniority: "decision-maker",
        company: prof.name || coName,
        companyDomain: domain,
        email,
        emailStatus: email ? "unverified" : undefined,
        linkedinUrl: p.url,
        city,
        state,
        country: "United States",
        tags: ["company-first", "decision-maker", bandLabel(prof)],
        origin: `co:${prof.name || coName}`,
        source: "manual",
        raw: {
          company_headcount: bandLabel(prof),
          ...(typeof prof.employees === "number" ? { company_employees: String(prof.employees) } : {}),
          ...(prof.hq ? { company_hq_location: prof.hq } : {}),
          ...(prof.website || prof.linkedinUrl ? { company_url: prof.website || prof.linkedinUrl! } : {}),
          ...(permutations && permutations.length ? { email_permutations: permutations.join(", ") } : {}),
        },
      });
      added++;
    }
  }

  if (batch.length) await upsertRecords(ws, batch);
  job.collected += added;
  job.seenPeople = [...seen];
  if (job.cursor >= job.segments.length || job.collected >= job.target) job.status = "done";
  await persist(job);

  return { job, added, requests, done: job.status === "done" };
}
