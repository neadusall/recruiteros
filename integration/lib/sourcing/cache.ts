/**
 * RecruitersOS · JD Sourcing — shared people cache.
 *
 * The two paid per-person lookups in sourcing — a full-profile fetch (deep-vet) and
 * a contact lookup (enrich) — are both keyed by the person. Running the same JD
 * twice, re-vetting, or enriching someone who showed up in an earlier list would
 * otherwise pay for the exact same lookup again. This caches both, workspace-scoped
 * and persisted (same hydrate-once / debounced-snapshot pattern as the runs store),
 * with a TTL so stale data eventually refreshes. Net effect: you pay once per person
 * per TTL window, no matter how many runs they appear in.
 *
 * Pure key/TTL math lives in cacheKeys.ts (free-testable); this file owns the store.
 */

import { loadSnapshot, debouncedSaver } from "../db";
import { nowIso } from "../core/ids";
import { fetchFullProfile, type FullProfile } from "./profile";
import { cacheKey, scopedKey, isFresh } from "./cacheKeys";

const KEY = "sourcing_cache_v1";

function ttlDays(envVar: string, dflt: number): number {
  const n = parseInt(process.env[envVar] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
// Profiles change slowly; contacts even more so. Both overridable via env.
const PROFILE_TTL = () => ttlDays("RECRUITEROS_SOURCING_PROFILE_TTL_DAYS", 60);
const CONTACT_TTL = () => ttlDays("RECRUITEROS_SOURCING_CONTACT_TTL_DAYS", 90);

export interface CachedProfile { profile: FullProfile; fetchedAt: string }
export interface CachedContact { email?: string; phone?: string; fetchedAt: string }
interface CacheBlob {
  profiles: Record<string, CachedProfile>;
  contacts: Record<string, CachedContact>;
}

let store: CacheBlob = { profiles: {}, contacts: {} };
let hydrated = false;
let hydrating: Promise<void> | null = null;

const save = debouncedSaver(KEY, () => store);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<CacheBlob>(KEY);
      if (snap && typeof snap === "object") {
        store = { profiles: snap.profiles ?? {}, contacts: snap.contacts ?? {} };
      }
      hydrated = true;
    })();
  }
  return hydrating;
}

/* ------------------------------------------------------------------ */
/* Full profiles (deep-vet)                                            */
/* ------------------------------------------------------------------ */

/** Fresh cached profile for this URL, or undefined on miss/stale. */
export async function getCachedProfile(workspaceId: string, url: string): Promise<FullProfile | undefined> {
  if (!url) return undefined;
  await hydrate();
  const hit = store.profiles[scopedKey(workspaceId, cacheKey(url))];
  return hit && isFresh(hit.fetchedAt, PROFILE_TTL()) ? hit.profile : undefined;
}

export async function putCachedProfile(workspaceId: string, url: string, profile: FullProfile): Promise<void> {
  if (!url) return;
  await hydrate();
  store.profiles[scopedKey(workspaceId, cacheKey(url))] = { profile, fetchedAt: nowIso() };
  save();
}

/**
 * Fetch a full profile, serving a fresh cached copy when one exists (no paid call).
 * Returns the profile plus whether it came from cache, so callers can report savings.
 */
export async function fetchFullProfileCached(
  workspaceId: string, url: string,
): Promise<{ profile: FullProfile; cached: boolean }> {
  const cachedProfile = await getCachedProfile(workspaceId, url);
  if (cachedProfile) return { profile: cachedProfile, cached: true };
  const profile = await fetchFullProfile(url);
  await putCachedProfile(workspaceId, url, profile);
  return { profile, cached: false };
}

/* ------------------------------------------------------------------ */
/* Contacts (enrich)                                                   */
/* ------------------------------------------------------------------ */

/** Fresh cached contact for this person key (URL or name|company), or undefined. */
export async function getCachedContact(workspaceId: string, personKey: string): Promise<CachedContact | undefined> {
  if (!personKey) return undefined;
  await hydrate();
  const hit = store.contacts[scopedKey(workspaceId, cacheKey(personKey))];
  return hit && isFresh(hit.fetchedAt, CONTACT_TTL()) ? hit : undefined;
}

export async function putCachedContact(
  workspaceId: string, personKey: string, contact: { email?: string; phone?: string },
): Promise<void> {
  if (!personKey || (!contact.email && !contact.phone)) return; // don't cache empty results
  await hydrate();
  store.contacts[scopedKey(workspaceId, cacheKey(personKey))] = {
    email: contact.email, phone: contact.phone, fetchedAt: nowIso(),
  };
  save();
}
