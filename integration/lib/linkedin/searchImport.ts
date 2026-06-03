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
import { getProvider } from "./provider";
import { toEngineAccount } from "./console";

import { addProspect } from "../prospects";

class ImportError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface ImportSearchInput {
  url: string;
  campaignId: string;
  /** Hard cap on profiles to pull (defaults to 100, max 500). */
  limit?: number;
  /** ICP bucket stamped on the created prospects. */
  category?: string;
  /** Active motion — tags prospects so they land in the right bucket. */
  motion?: "bd" | "recruiting";
}

export interface ImportSearchResult {
  /** New prospects created. */
  added: number;
  /** Profiles skipped because the same LinkedIn URL was already a prospect. */
  deduped: number;
  /** Total profiles the provider returned. */
  found: number;
  /** The sending account the search ran through. */
  account: string;
}

const SEARCH_HOST = /linkedin\.com\/(sales\/search|search\/results|talent\/search|sales\/lists)/i;

/** Cheap guard so we don't fire a provider call on an obvious paste mistake. */
export function looksLikeSearchUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?linkedin\.com\//i.test(url.trim());
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

  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  let profiles;
  try {
    profiles = await getProvider().searchProfiles({ account, url, limit });
  } catch (err) {
    // Surface as a 4xx, NOT a 5xx: an unconfigured provider is a setup problem
    // the recruiter can act on. Critically, a 5xx makes the static-demo fetch
    // shim fall back and fabricate fake prospects (instant "added: N" that never
    // appear in the real pipeline) — so we must keep this client-side.
    throw new ImportError(`search_unavailable: ${(err as Error).message}`, 422);
  }

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

  return { added, deduped, found: profiles.length, account: core.handle };
}
