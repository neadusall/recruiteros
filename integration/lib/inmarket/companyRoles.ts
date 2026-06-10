/**
 * RecruiterOS · In-Market · Company role expansion ("what ELSE are they hiring for")
 *
 * A company usually surfaces from ONE job listing, but it's almost always hiring for many
 * more. This resolves the company's OWN public ATS board and returns EVERY open role — with
 * NO aggregator API and no key, because the board is the company's own public JSON endpoint:
 *
 *   Greenhouse · Lever · Ashby · Workable · SmartRecruiters · Recruitee
 *
 * We derive candidate board slugs from the domain + name, try each ATS shape until one
 * board answers, then return its full (US-filtered) role list. Results are cached per company
 * so a repeat "find all roles" is instant. On-demand only — triggered by the deep-dive button,
 * never in the bulk accumulator.
 */

import { getJson } from "../signals/sources";
import { loadSnapshot, saveSnapshot } from "../db";
import { isUsLocation } from "./geo";

export interface CompanyRole {
  title: string;
  location?: string;
  department?: string;
  url?: string;
  /** When the role was posted on the company's own board (ISO), when the ATS exposes it. */
  postedAt?: string;
}

function toIso(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && isFinite(v)) { try { return new Date(v > 1e12 ? v : v * 1000).toISOString(); } catch { return undefined; } }
  return undefined;
}

export interface CompanyRolesResult {
  roles: CompanyRole[];
  /** Which ATS answered, e.g. "Greenhouse" — empty when nothing resolved. */
  source: string;
  /** The slug that hit, for debugging. */
  slug?: string;
}

const CACHE_KEY = "inmarket_company_roles_v1";
const TTL_MS = 3 * 24 * 60 * 60 * 1000; // roles change; re-check after 3 days
const MAX_ROLES = 80;

interface CacheEntry { result: CompanyRolesResult; at: number }

/** Candidate ATS board slugs from a domain + company name (most-likely first). */
function slugsFor(company: string, domain?: string): string[] {
  const out: string[] = [];
  const add = (s?: string) => { const v = (s || "").trim(); if (v.length >= 2 && !out.includes(v)) out.push(v); };
  if (domain) {
    const host = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    const sld = (host.split(".")[0] || "").toLowerCase();
    add(sld);
    add(sld.replace(/-/g, ""));
  }
  const base = company.toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|gmbh|plc|sa|ag|group|holdings|technologies|labs|software|systems)\b/g, "")
    .replace(/[.,&'"`/()]/g, " ")
    .trim();
  add(base.replace(/[^a-z0-9]+/g, ""));                       // greenhouse/workable: "acmecorp"
  add(base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")); // lever/recruitee: "acme-corp"
  return out.slice(0, 4);
}

/* --- One ATS board fetch per provider; returns [] on any miss/non-board. --- */

async function greenhouse(slug: string): Promise<CompanyRole[]> {
  const r = await getJson<{ jobs?: Array<{ title: string; location?: { name?: string }; departments?: { name?: string }[]; absolute_url?: string; updated_at?: string; first_published?: string }> }>(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=false`,
  );
  return (r.jobs ?? []).map((j) => ({ title: j.title, location: j.location?.name, department: j.departments?.[0]?.name, url: j.absolute_url, postedAt: toIso(j.first_published) ?? toIso(j.updated_at) }));
}
async function lever(slug: string): Promise<CompanyRole[]> {
  const r = await getJson<Array<{ text: string; categories?: { location?: string; team?: string }; hostedUrl?: string; createdAt?: number }>>(
    `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
  );
  return (Array.isArray(r) ? r : []).map((p) => ({ title: p.text, location: p.categories?.location, department: p.categories?.team, url: p.hostedUrl, postedAt: toIso(p.createdAt) }));
}
async function ashby(slug: string): Promise<CompanyRole[]> {
  const r = await getJson<{ jobs?: Array<{ title: string; location?: string; department?: string; jobUrl?: string; publishedAt?: string }> }>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
  );
  return (r.jobs ?? []).map((j) => ({ title: j.title, location: j.location, department: j.department, url: j.jobUrl, postedAt: toIso(j.publishedAt) }));
}
async function workable(slug: string): Promise<CompanyRole[]> {
  const r = await getJson<{ jobs?: Array<{ title: string; location?: { location_str?: string }; department?: string; url?: string; published_on?: string }> }>(
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`,
  );
  return (r.jobs ?? []).map((j) => ({ title: j.title, location: j.location?.location_str, department: j.department, url: j.url, postedAt: toIso(j.published_on) }));
}
async function smartrecruiters(slug: string): Promise<CompanyRole[]> {
  const r = await getJson<{ content?: Array<{ name: string; location?: { city?: string }; department?: { label?: string }; ref?: string; releasedDate?: string }> }>(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings`,
  );
  return (r.content ?? []).map((j) => ({ title: j.name, location: j.location?.city, department: j.department?.label, url: j.ref, postedAt: toIso(j.releasedDate) }));
}
async function recruitee(slug: string): Promise<CompanyRole[]> {
  const r = await getJson<{ offers?: Array<{ title: string; location?: string; department?: string; careers_url?: string; published_at?: string }> }>(
    `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`,
  );
  return (r.offers ?? []).map((o) => ({ title: o.title, location: o.location, department: o.department, url: o.careers_url, postedAt: toIso(o.published_at) }));
}

const PROVIDERS: Array<{ name: string; fn: (slug: string) => Promise<CompanyRole[]> }> = [
  { name: "Greenhouse", fn: greenhouse },
  { name: "Lever", fn: lever },
  { name: "Ashby", fn: ashby },
  { name: "Workable", fn: workable },
  { name: "SmartRecruiters", fn: smartrecruiters },
  { name: "Recruitee", fn: recruitee },
];

/** Keep US roles: drop a role only when its location is positively non-US (a US company's
 *  unspecified-location reqs are kept — they're typically HQ/US). De-dupe by title. */
function cleanRoles(roles: CompanyRole[]): CompanyRole[] {
  const seen = new Set<string>();
  const out: CompanyRole[] = [];
  for (const r of roles) {
    const title = (r.title || "").trim();
    if (!title) continue;
    if (r.location && r.location.trim() && !isUsLocation(r.location)) continue; // drop clearly non-US
    const k = title.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...r, title });
    if (out.length >= MAX_ROLES) break;
  }
  return out;
}

/**
 * Resolve EVERY open role for a company from its own public ATS board (no aggregator API).
 * Tries candidate slugs across the six ATS providers; first board that answers wins. Cached
 * per company. Returns an empty list (with source "") when no public board is found.
 */
export async function resolveCompanyRoles(company: string, domain?: string): Promise<CompanyRolesResult> {
  const key = (company || "").toLowerCase().trim();
  if (!key) return { roles: [], source: "" };

  const cache = (await loadSnapshot<Record<string, CacheEntry>>(CACHE_KEY).catch(() => null)) || {};
  const hit = cache[key];
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;

  const slugs = slugsFor(company, domain);
  let result: CompanyRolesResult = { roles: [], source: "" };
  outer: for (const slug of slugs) {
    for (const p of PROVIDERS) {
      try {
        const roles = cleanRoles(await p.fn(slug));
        if (roles.length) { result = { roles, source: p.name, slug }; break outer; }
      } catch { /* not this provider/slug — try next */ }
    }
  }

  try { cache[key] = { result, at: Date.now() }; await saveSnapshot(CACHE_KEY, cache); } catch { /* best-effort cache */ }
  return result;
}
