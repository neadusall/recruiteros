/**
 * RecruitersOS · JD Sourcing
 * Full-profile fetch — the data the deep-vet needs that search results don't carry.
 *
 * The people-SEARCH endpoint returns only a surface row (name, title, company,
 * location, URL). To judge whether someone TRULY qualifies you need their work
 * history — roles, tenure per role, progression, education. That lives behind a
 * separate RapidAPI "profile by URL" listing. Configure it the same way as search:
 *
 *   RAPIDAPI_KEY                (workspace-first, shared with search)
 *   RAPIDAPI_PROFILE_HOST       e.g. fresh-linkedin-profile-data.p.rapidapi.com
 *   RAPIDAPI_PROFILE_PATH       e.g. /get-linkedin-profile?linkedin_url={url}  ({url} interpolated)
 *
 * If no profile endpoint is configured, the deep-vet still runs on whatever fields
 * the search row carried (degraded depth, flagged) — it never fabricates history.
 */

import { cred } from "../providers/http";

const RAPIDAPI_KEY = () => cred("RAPIDAPI_KEY");
const PROFILE_HOST = () => cred("RAPIDAPI_PROFILE_HOST");
const PROFILE_PATH = () => cred("RAPIDAPI_PROFILE_PATH") || "/profile?url={url}"; // GET: {url} interpolated
// "GET" (url in the query) or "POST" (url in a JSON body, e.g. {"link": url} for person_deep).
const PROFILE_METHOD = () => (cred("RAPIDAPI_PROFILE_METHOD") || "GET").trim().toUpperCase();
// Body key the POST profile endpoint expects the URL under (person_deep uses "link").
const PROFILE_BODY_KEY = () => cred("RAPIDAPI_PROFILE_BODY_KEY") || "link";

export function profileFetchConfigured(): boolean {
  return Boolean(RAPIDAPI_KEY() && PROFILE_HOST());
}

/** One role in the candidate's history. */
export interface ProfileExperience {
  title?: string;
  company?: string;
  start?: string;
  end?: string;
  durationMonths?: number;
  location?: string;
  description?: string;
}

/** Normalized full profile — only the fields the vet actually reasons over. */
export interface FullProfile {
  fullName?: string;
  headline?: string;
  summary?: string;
  location?: string;
  experiences: ProfileExperience[];
  education: string[];
  skills: string[];
  totalYears?: number;
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s || undefined;
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Months from a "2 yrs 10 mos" / "1 yr" duration phrase. */
function durMonths(s?: string): number | undefined {
  if (!s) return undefined;
  const y = /(\d+)\s*yr/i.exec(s); const m = /(\d+)\s*mo/i.exec(s);
  const months = (y ? +y[1] * 12 : 0) + (m ? +m[1] : 0);
  return months || undefined;
}

/** Split "Mar 2021 - Present · 2 yrs 10 mos" into start/end (ignores the duration tail). */
function dateRange(s?: string): { start?: string; end?: string } {
  if (!s) return {};
  const head = s.split("·")[0].trim();
  const parts = head.split(/\s[-–—]\s/).map((x) => x.trim());
  return { start: parts[0] || undefined, end: parts[1] || undefined };
}

/** Flatten a [{type,text}] / string / array description into one string. */
function descText(d: any): string | undefined {
  if (!d) return undefined;
  if (typeof d === "string") return str(d);
  if (Array.isArray(d)) {
    const t = d.map((x) => (typeof x === "string" ? x : str(x && x.text))).filter(Boolean).join(" ");
    return str(t);
  }
  return undefined;
}

/**
 * Pull an experience list out of the response. Handles both:
 *  - flat rows ({title, company, start, end}), and
 *  - LinkedIn-style grouped rows where `title` is the company and `subComponents[]`
 *    hold the roles (title + dated caption), or `title` is the role and `subtitle`
 *    the company. Defensive about which shape a given listing returns.
 */
function extractExperiences(o: any): ProfileExperience[] {
  const arr = o?.experiences || o?.experience || o?.positions || o?.work_experience ||
    o?.workExperience || o?.position_groups || [];
  if (!Array.isArray(arr)) return [];
  const out: ProfileExperience[] = [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const subs = Array.isArray(e.subComponents) ? e.subComponents : [];
    const roleSubs = subs.filter((s: any) => s && str(s.title));
    if (roleSubs.length) {
      // Grouped: e.title is the company; each subComponent with a title is a role.
      const company = str(e.title) || str(e.subtitle) || str(e.company);
      for (const s of roleSubs) {
        const cap = str(s.caption);
        const dr = dateRange(cap);
        out.push({
          title: str(s.title), company,
          start: dr.start, end: dr.end,
          durationMonths: durMonths(cap) || durMonths(str(e.subtitle)),
          location: str(e.caption) && !/\d{4}/.test(String(e.caption)) ? str(e.caption) : str(e.metadata),
          description: descText(s.description),
        });
      }
    } else {
      // Single role: title=role, subtitle=company (or explicit flat fields).
      const cap = str(e.caption);
      const dr = dateRange(cap);
      out.push({
        title: str(e.title) || str(e.job_title) || str(e.jobTitle) || str(e.position),
        company: str(e.subtitle) || str(e.company) || str(e.company_name) || str(e.companyName) || str(e.organization),
        start: dr.start || str(e.start) || str(e.starts_at) || str(e.start_date) || str(e.startDate),
        end: dr.end || str(e.end) || str(e.ends_at) || str(e.end_date) || str(e.endDate) || (e.is_current ? "Present" : undefined),
        durationMonths: durMonths(cap) || num(e.duration_months) || num(e.durationMonths),
        location: str(e.metadata) || str(e.location) || str(e.geo),
        description: descText(e.description) || (subs[0] ? descText(subs[0].description) : undefined),
      });
    }
  }
  return out.filter((e) => Boolean(e.title || e.company)).slice(0, 20);
}

function extractEducation(o: any): string[] {
  const arr = o?.education || o?.educations || o?.schools || [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((e: any) => {
      if (typeof e === "string") return e;
      const school = str(e.title) || str(e.school) || str(e.school_name) || str(e.name) || str(e.institution);
      const degree = str(e.subtitle) || str(e.degree) || str(e.degree_name) || str(e.field_of_study) || str(e.field);
      return [degree, school].filter(Boolean).join(" — ");
    })
    .filter(Boolean)
    .slice(0, 8);
}

function extractSkills(o: any): string[] {
  const arr = o?.skills || o?.skill_list || [];
  if (!Array.isArray(arr)) return [];
  return arr.map((s: any) => (typeof s === "string" ? s : (str(s?.title) || str(s?.name)))).filter(Boolean).slice(0, 40) as string[];
}

/** True once we've reached the actual profile object (vs an envelope wrapper). */
function looksLikeProfile(o: any): boolean {
  return Boolean(o && typeof o === "object" &&
    (o.fullName || o.full_name || o.firstName || o.first_name || o.experiences || o.experience || o.headline || o.about));
}

/** Drill through nested envelopes (data, data.data, profile, …) to the profile object. */
function unwrap(data: any): any {
  let o = data; let guard = 0;
  while (o && typeof o === "object" && !looksLikeProfile(o) && guard < 6) {
    let next: any;
    for (const k of ["data", "profile", "result", "person", "response"]) {
      if (o[k] && typeof o[k] === "object") { next = o[k]; break; }
    }
    if (!next) break;
    o = next; guard++;
  }
  return o;
}

/**
 * Fetch the full profile for a LinkedIn URL. Throws on a configured-but-failing
 * endpoint so the caller can record the warning; returns a normalized profile on
 * success. Never invents data.
 */
export async function fetchFullProfile(linkedinUrl: string): Promise<FullProfile> {
  const host = PROFILE_HOST();
  const headers: Record<string, string> = {
    "X-RapidAPI-Key": RAPIDAPI_KEY(), "X-RapidAPI-Host": host,
    Accept: "application/json", "Content-Type": "application/json",
  };

  let res: Response;
  if (PROFILE_METHOD() === "POST") {
    // Body-based lookup (e.g. person_deep): the URL rides in the JSON body.
    res = await fetch(`https://${host}${PROFILE_PATH()}`, {
      method: "POST", headers, body: JSON.stringify({ [PROFILE_BODY_KEY()]: linkedinUrl }),
    });
  } else {
    const path = PROFILE_PATH().replace("{url}", encodeURIComponent(linkedinUrl));
    const url = `https://${host}${path}${path.includes("{") || path.includes("url=") ? "" : (path.includes("?") ? "&" : "?") + "url=" + encodeURIComponent(linkedinUrl)}`;
    res = await fetch(url, { headers });
  }
  if (!res.ok) throw new Error(`profile ${host} ${res.status}`);
  const raw = await res.json().catch(() => ({}));
  if (raw && raw.success === false && raw.error) throw new Error(`profile ${host}: ${String(raw.error)}`);
  const o = unwrap(raw);
  const experiences = extractExperiences(o);
  const months = experiences.reduce((acc, e) => acc + (e.durationMonths || 0), 0);
  return {
    fullName: str(o.fullName) || str(o.full_name) || str(o.name),
    headline: str(o.headline) || str(o.sub_title),
    summary: str(o.summary) || str(o.about),
    location: str(o.location) || str(o.geo) || str(o.city),
    experiences,
    education: extractEducation(o),
    skills: extractSkills(o),
    totalYears: months ? Math.round((months / 12) * 10) / 10 : undefined,
  };
}
