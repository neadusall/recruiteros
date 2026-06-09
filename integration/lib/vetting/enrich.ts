/**
 * RecruiterOS · AI Vetting · Candidate enrichment
 *
 * At opt-in we have a LinkedIn URL. We resolve it (once) into a small, human
 * slice the agent can reference on the call — current title/company plus a few
 * recent roles — so the candidate feels HEARD ("I saw you spent six years at
 * Acme…"). This is the same enrichment rung Hire Signals uses (FreshLinkedIn via
 * RapidAPI); it degrades to an empty, source:"none" result when the provider
 * isn't keyed, exactly like every other integration's dry-run path.
 *
 * We deliberately keep only what's useful for talking points — not a full
 * profile dump — so it drops straight into the prompt without bloating it.
 */

import { freshLinkedin } from "../providers";
import type { CandidateEnrichment } from "./types";
import { nowIso } from "../core/ids";

/** Pull the first present string field from a loosely-typed provider object. */
function pick(obj: any, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** Turn one experience entry into a short "Title at Company (years)" line. */
function expLine(e: any): string | null {
  const title = pick(e, "title", "position", "job_title", "role");
  const company = pick(e, "company", "company_name", "organization");
  if (!title && !company) return null;
  const span =
    pick(e, "date_range", "duration", "dates") ||
    [pick(e, "start_year", "starts_at", "start_date"), pick(e, "end_year", "ends_at", "end_date")]
      .filter(Boolean)
      .join("–");
  const head = [title, company].filter(Boolean).join(" at ");
  return span ? `${head} (${span})` : head;
}

const EMPTY: CandidateEnrichment = {
  experience: [],
  source: "none",
  fetchedAt: "",
};

/**
 * Resolve a LinkedIn URL into talking-point enrichment. Never throws — on any
 * failure (no key, bad URL, provider error) it returns an empty source:"none"
 * result so the opt-in flow and the live call both keep working.
 */
export async function enrichCandidate(linkedinUrl?: string): Promise<CandidateEnrichment> {
  const url = (linkedinUrl || "").trim();
  if (!url || !freshLinkedin.configured()) {
    return { ...EMPTY, fetchedAt: nowIso() };
  }

  try {
    const res: any = await freshLinkedin.getProfile(url);
    // The RapidAPI shape nests the profile under `data` in most plans.
    const p = res?.data ?? res ?? {};

    const experiences: any[] = Array.isArray(p.experiences)
      ? p.experiences
      : Array.isArray(p.experience)
        ? p.experience
        : [];
    const expLines = experiences.map(expLine).filter((x): x is string => Boolean(x)).slice(0, 5);

    const currentTitle = pick(p, "job_title", "headline", "occupation") || (experiences[0] ? pick(experiences[0], "title", "position") : undefined);
    const currentCompany = pick(p, "company", "company_name") || (experiences[0] ? pick(experiences[0], "company", "company_name") : undefined);

    return {
      headline: pick(p, "headline", "sub_title"),
      currentTitle,
      currentCompany,
      location: pick(p, "location", "city", "geo"),
      experience: expLines,
      summary: pick(p, "summary", "about", "bio")?.slice(0, 400),
      source: "fresh_linkedin",
      fetchedAt: nowIso(),
    };
  } catch {
    return { ...EMPTY, fetchedAt: nowIso() };
  }
}
