/**
 * RecruiterOS · LinkedIn search import ("Enrich LinkedIn searches")
 *
 * Turns a pasted LinkedIn / Sales Navigator search URL into Prospects. The
 * recruiter runs a search inside Sales Navigator, copies the URL, and drops it
 * here; we drive the connected LinkedIn account through the provider to pull the
 * matching members and create a prospect for each (first/last name, company,
 * title, headline, profile URL — everything the search exposes).
 *
 * This is the *discovery* half only. Per the project's cost discipline, no paid
 * contact lookup happens here: the recruiter then enriches each prospect's
 * business email / phone / personal cell on demand from the Prospects section
 * (the existing cheapest-first waterfall in `enrichProspect`).
 */

import { listLinkedInAccounts } from "../accounts";
import { getCore } from "../core/repository";
import { getProvider, type SearchProfile } from "./provider";
import { toEngineAccount } from "./console";
import {
  scraperConfigured,
  isProfileUrl,
  scrapeProfileViaSidecar,
  scrapeSearchViaSidecar,
  ScraperError,
} from "./scraperProvider";

import { addProspect } from "../prospects";

class ImportError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Which backend pulls the profiles: the Unipile API (default) or the
 *  open-source Playwright scraper sidecar (cookie-authenticated). */
export type SearchEngine = "unipile" | "scraper";

export interface ImportSearchInput {
  url: string;
  campaignId: string;
  /** Hard cap on profiles to pull (defaults to 100, max 500). */
  limit?: number;
  /** ICP bucket stamped on the created prospects. */
  category?: string;
  /** Active motion — tags prospects so they land in the right bucket. */
  motion?: "bd" | "recruiting";
  /** Search backend. Defaults to "unipile" to preserve existing behavior. */
  engine?: SearchEngine;
}

export interface ImportSearchResult {
  /** New prospects created. */
  added: number;
  /** Profiles skipped because the same LinkedIn URL was already a prospect. */
  deduped: number;
  /** Total profiles the provider returned. */
  found: number;
  /** The sending account / engine the search ran through. */
  account: string;
  /** Which engine ran. */
  engine: SearchEngine;
  /** Best-effort warnings (e.g. scraper extraction was thin). */
  warnings?: string[];
}

const SEARCH_HOST = /linkedin\.com\/(sales\/search|search\/results|talent\/search|sales\/lists)/i;

/** Cheap guard so we don't fire a provider call on an obvious paste mistake. */
export function looksLikeSearchUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?linkedin\.com\//i.test(url.trim());
}

/**
 * Dedupe by LinkedIn URL and create a prospect per surviving profile. Shared by
 * both engines so motion tagging + dedupe behave identically regardless of where
 * the profiles came from.
 */
async function addProfilesAsProspects(
  workspaceId: string,
  input: ImportSearchInput,
  profiles: SearchProfile[],
): Promise<{ added: number; deduped: number }> {
  const repo = getCore();
  let added = 0;
  let deduped = 0;
  for (const p of profiles) {
    const linkedinUrl = p.publicProfileUrl;
    if (linkedinUrl) {
      const existing = await repo.findProspectByLinkedin(workspaceId, linkedinUrl);
      if (existing) {
        deduped++;
        continue;
      }
    }
    await addProspect({
      workspaceId,
      campaignId: input.campaignId,
      motion: input.motion,
      fullName: p.fullName,
      title: p.title || p.headline,
      headline: p.headline,
      company: p.company,
      location: p.location,
      photoUrl: p.imageUrl,
      linkedinUrl,
      category: input.category ?? "linkedin_search",
    });
    added++;
  }
  return { added, deduped };
}

/**
 * Scraper engine: pull profiles via the Playwright sidecar (cookie auth). A
 * profile URL (/in/...) scrapes that one person; any other LinkedIn URL is
 * treated as a people-search and paged through best-effort. No connected
 * LinkedIn *account* is needed — the sidecar authenticates with the li_at cookie.
 */
async function importViaScraper(
  workspaceId: string,
  input: ImportSearchInput,
  url: string,
  limit: number,
): Promise<ImportSearchResult> {
  if (!scraperConfigured()) {
    throw new ImportError("scraper_not_configured", 409);
  }
  let profiles: SearchProfile[];
  let warnings: string[] | undefined;
  try {
    if (isProfileUrl(url)) {
      profiles = await scrapeProfileViaSidecar(url);
    } else {
      const r = await scrapeSearchViaSidecar(url, limit);
      profiles = r.profiles;
      warnings = r.warnings;
    }
  } catch (err) {
    if (err instanceof ScraperError) {
      // Pass the sidecar's status through (429 rate-limited, 401 bad cookie,
      // 503 unreachable) so the UI can show the right hint.
      throw new ImportError(`scrape_${err.status}: ${err.message}`, err.status);
    }
    throw new ImportError(`scrape_failed: ${(err as Error).message}`, 502);
  }
  const { added, deduped } = await addProfilesAsProspects(workspaceId, input, profiles);
  return { added, deduped, found: profiles.length, account: "li_at cookie", engine: "scraper", warnings };
}

/**
 * Pull every member from a LinkedIn / Sales Navigator search URL into the pipeline.
 *
 * Runs through the workspace's first usable LinkedIn account. Profiles already in
 * the pipeline (matched by LinkedIn URL) are skipped, so re-running a search only
 * adds what's new. With no provider keys configured the provider throws and we
 * surface a clean error rather than a half-import.
 */
export async function importFromLinkedInSearch(
  workspaceId: string,
  ownerUserId: string,
  input: ImportSearchInput,
): Promise<ImportSearchResult> {
  const url = (input.url || "").trim();
  if (!looksLikeSearchUrl(url)) {
    throw new ImportError("not_a_linkedin_url", 422);
  }
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);

  // Scraper engine: cookie-authenticated sidecar. Accepts a single /in/ profile
  // URL (reliable) or any people-search URL (best-effort pagination).
  if (input.engine === "scraper") {
    return importViaScraper(workspaceId, input, url, limit);
  }

  // Unipile engine (default): drive a connected LinkedIn account through the API.
  if (!SEARCH_HOST.test(url)) {
    // Not fatal — a profile/company URL won't return a list, but the provider may
    // still resolve it. We warn by status so the UI can hint at the right URL.
    throw new ImportError("not_a_search_url", 422);
  }

  // Pick a connected, non-flagged LinkedIn account to run the search through.
  const core = listLinkedInAccounts(workspaceId).find((a) => a.active && a.warmup !== "flagged");
  if (!core) {
    throw new ImportError("no_linkedin_account", 409);
  }
  const account = toEngineAccount(core, ownerUserId);

  let profiles: SearchProfile[];
  try {
    profiles = await getProvider().searchProfiles({ account, url, limit });
  } catch (err) {
    // Surface as a 4xx, NOT a 5xx: an unconfigured provider is a setup problem
    // the recruiter can act on. Critically, a 5xx makes the static-demo fetch
    // shim fall back and fabricate fake prospects (instant "added: N" that never
    // appear in the real pipeline) — so we must keep this client-side.
    throw new ImportError(`search_unavailable: ${(err as Error).message}`, 422);
  }

  const { added, deduped } = await addProfilesAsProspects(workspaceId, input, profiles);
  return { added, deduped, found: profiles.length, account: core.handle, engine: "unipile" };
}
