/**
 * RecruitersOS · Core
 * Deterministic, dependency-free id + time helpers.
 *
 * Ids are prefixed by entity so they read well in logs and the inbox UI.
 * In production swap `rid` for your db's id strategy (cuid/uuid); the prefix
 * convention is all the rest of the engine relies on.
 */

let counter = 0;

/** Short, sortable-ish id with an entity prefix, e.g. "resp_lq8x3a01". */
export function rid(prefix: string): string {
  counter = (counter + 1) % 0xffffff;
  const t = Date.now().toString(36);
  const c = counter.toString(36).padStart(3, "0");
  return `${prefix}_${t}${c}`;
}

/** Current ISO timestamp (single seam so tests can freeze time). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** ISO timestamp `hours` from `fromIso` (defaults to now). */
export function isoPlusHours(hours: number, fromIso?: string): string {
  const base = fromIso ? Date.parse(fromIso) : Date.now();
  return new Date(base + hours * 3_600_000).toISOString();
}

/** Calendar date (YYYY-MM-DD) for stamping booked_at-style fields. */
export function today(fromIso?: string): string {
  return (fromIso ? new Date(fromIso) : new Date()).toISOString().slice(0, 10);
}
