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

/** Pull an experience array out of whatever envelope the listing returns. */
function extractExperiences(o: any): ProfileExperience[] {
  const arr =
    o?.experiences || o?.experience || o?.positions || o?.work_experience ||
    o?.workExperience || o?.position_groups || [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((e: any): ProfileExperience | null => {
      if (!e || typeof e !== "object") return null;
      return {
        title: str(e.title) || str(e.job_title) || str(e.jobTitle) || str(e.position),
        company: str(e.company) || str(e.company_name) || str(e.companyName) || str(e.organization),
        start: str(e.start) || str(e.starts_at) || str(e.start_date) || str(e.startDate),
        end: str(e.end) || str(e.ends_at) || str(e.end_date) || str(e.endDate) || (e.is_current ? "Present" : undefined),
        durationMonths: num(e.duration_months) || num(e.durationMonths),
        location: str(e.location) || str(e.geo),
        description: str(e.description) || str(e.summary),
      };
    })
    .filter((e): e is ProfileExperience => Boolean(e && (e.title || e.company)));
}

function extractEducation(o: any): string[] {
  const arr = o?.education || o?.educations || o?.schools || [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((e: any) => {
      if (typeof e === "string") return e;
      const school = str(e.school) || str(e.school_name) || str(e.name) || str(e.institution);
      const degree = str(e.degree) || str(e.degree_name) || str(e.field_of_study) || str(e.field);
      return [degree, school].filter(Boolean).join(" — ");
    })
    .filter(Boolean)
    .slice(0, 8);
}

function extractSkills(o: any): string[] {
  const arr = o?.skills || o?.skill_list || [];
  if (!Array.isArray(arr)) return [];
  return arr.map((s: any) => (typeof s === "string" ? s : str(s?.name))).filter(Boolean).slice(0, 40) as string[];
}

/** Pull the profile object out of whatever envelope the listing returns. */
function unwrap(data: any): any {
  if (data && typeof data === "object") {
    for (const k of ["data", "profile", "result", "person", "response"]) {
      if (data[k] && typeof data[k] === "object") return data[k];
    }
  }
  return data;
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
