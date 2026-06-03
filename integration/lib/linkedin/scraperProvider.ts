/**
 * RecruiterOS · LinkedIn scraper engine (client)
 *
 * Thin HTTP client to the Python `scraper` sidecar (Playwright + the open-source
 * linkedin-scraper). This is the ALTERNATIVE engine to Unipile for the "Pull
 * LinkedIn profiles" flow: a free, cookie-authenticated path the recruiter can
 * pick per search.
 *
 * The backend never touches Playwright — it POSTs a URL here and gets back the
 * same `SearchProfile` shape the Unipile provider returns, so `searchImport`
 * treats both engines identically. The `li_at` cookie is read from env and sent
 * per request; all anti-block discipline (serialization, jitter, page delays,
 * rate caps) lives in the sidecar.
 */

import type { SearchProfile } from "./provider";

const SCRAPER_URL = (process.env.SCRAPER_URL || "http://scraper:8000").replace(/\/$/, "");
const SCRAPER_TOKEN = process.env.SCRAPER_TOKEN || "";
const LI_AT = process.env.LINKEDIN_LI_AT || "";

export class ScraperError extends Error {
  constructor(message: string, readonly status = 502, readonly retryAfter?: number) {
    super(message);
  }
}

/** The scraper engine is usable only when a session cookie is configured. */
export function scraperConfigured(): boolean {
  return Boolean(LI_AT);
}

export function isProfileUrl(url: string): boolean {
  return /linkedin\.com\/in\//i.test(url || "");
}

interface SidecarProfile {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  headline?: string | null;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  profileUrl?: string | null;
  imageUrl?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** Map the sidecar's profile JSON onto the engine-wide SearchProfile shape. */
function toSearchProfile(p: SidecarProfile): SearchProfile {
  const fullName = (p.name || [p.firstName, p.lastName].filter(Boolean).join(" ")).trim();
  return {
    providerProfileId: p.profileUrl || fullName,
    fullName,
    firstName: p.firstName || undefined,
    lastName: p.lastName || undefined,
    headline: p.headline || undefined,
    title: p.title || undefined,
    company: p.company || undefined,
    location: p.location || undefined,
    publicProfileUrl: p.profileUrl || undefined,
    imageUrl: p.imageUrl || undefined,
  };
}

async function call(path: string, payload: Record<string, unknown>): Promise<any> {
  if (!scraperConfigured()) {
    throw new ScraperError("scraper_not_configured: set LINKEDIN_LI_AT", 409);
  }
  let res: Response;
  try {
    res = await fetch(`${SCRAPER_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-scraper-token": SCRAPER_TOKEN },
      body: JSON.stringify({ cookie: LI_AT, ...payload }),
    });
  } catch (err) {
    // Sidecar unreachable (not deployed / still booting). Surface as a 4xx so the
    // UI shows a setup hint instead of a generic 500.
    throw new ScraperError(`scraper_unreachable: ${(err as Error).message}`, 503);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const retryAfter = Number(res.headers.get("retry-after")) || undefined;
    throw new ScraperError(data?.detail || `scraper_error_${res.status}`, res.status, retryAfter);
  }
  return data;
}

/** Scrape ONE profile by /in/ URL (the reliable path). */
export async function scrapeProfileViaSidecar(url: string): Promise<SearchProfile[]> {
  const data = await call("/scrape/profile", { url });
  const p = data?.profile as SidecarProfile | undefined;
  if (!p || !(p.name || p.firstName)) return [];
  return [toSearchProfile(p)];
}

/** Best-effort: page through a people-search URL. Returns profiles + warnings. */
export async function scrapeSearchViaSidecar(
  url: string,
  limit: number,
): Promise<{ profiles: SearchProfile[]; warnings: string[] }> {
  const data = await call("/scrape/search", { url, limit });
  const list = (data?.profiles as SidecarProfile[] | undefined) || [];
  return {
    profiles: list.map(toSearchProfile).filter((p) => p.fullName),
    warnings: (data?.warnings as string[] | undefined) || [],
  };
}
