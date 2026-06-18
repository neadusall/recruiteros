/**
 * RecruitersOS · JD Sourcing — cache key + freshness helpers (pure).
 *
 * Split out of cache.ts on purpose: NO runtime imports, so the eval harness can
 * exercise the normalization + TTL math for free (no db, no network), the same way
 * vetParse.ts is testable. cache.ts owns the persisted store and imports these.
 */

const DAY_MS = 86_400_000;

/**
 * Normalize a LinkedIn URL (or a "name|company" fallback) into a stable cache key:
 * lowercased, query string dropped, trailing slashes removed. Two records for the
 * same person collapse to one key so we never pay to look them up twice.
 */
export function cacheKey(idOrUrl: string): string {
  return (idOrUrl || "").trim().toLowerCase().split("?")[0].replace(/\/+$/, "");
}

/** Workspace-scope a key so one workspace's cache never serves another's. */
export function scopedKey(workspaceId: string, key: string): string {
  return `${workspaceId}\n${key}`;
}

/**
 * True if a snapshot taken at `fetchedAt` (ISO) is still within its TTL window.
 * `now` is injectable so the math is deterministically testable. An unparseable
 * timestamp is treated as stale (cache miss) rather than fresh.
 */
export function isFresh(fetchedAt: string, ttlDays: number, now: number = Date.now()): boolean {
  const t = Date.parse(fetchedAt);
  if (!Number.isFinite(t)) return false;
  return now - t < ttlDays * DAY_MS;
}
