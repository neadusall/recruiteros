/**
 * RecruitersOS · Senders · HARD sending limits
 *
 * These are intentionally hard-coded, not user-tunable: every Email ID sends at
 * most COLD_PER_INBOX *cold* emails/day — the real deliverability ceiling we max
 * each inbox to. Warming is handled EXTERNALLY by Smartlead.ai at WARMING_PER_INBOX
 * /day; we never send those, we only display them for context. Inboxes are
 * provisioned INBOXES_PER_DOMAIN per sending domain.
 *
 * Capacity math the Send Queue shows:
 *   cold sends/day  = activeInboxes × COLD_PER_INBOX        (e.g. 50 IDs × 2 = 100/domain)
 *   warming/day     = activeInboxes × WARMING_PER_INBOX     (Smartlead, informational)
 */
export const COLD_PER_INBOX = 2;        // DEFAULT cold emails/day for a NEW Email ID (safe default)
export const WARMING_PER_INBOX = 10;    // Smartlead warming emails/day per Email ID (informational)
export const INBOXES_PER_DOMAIN = 50;   // Email IDs provisioned per sending domain
export const MAX_COLD_PER_INBOX = 30;   // ABSOLUTE hard ceiling — an inbox can NEVER exceed this, whatever is stored

/**
 * Effective cold cap for an inbox. Honors the inbox's stored daily cap, but never
 * above the absolute hard ceiling (MAX_COLD_PER_INBOX). Falls back to the safe
 * default (COLD_PER_INBOX) when nothing valid is stored.
 */
export function coldCap(storedDailyCap?: number): number {
  const n = Number(storedDailyCap);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_COLD_PER_INBOX) : COLD_PER_INBOX;
}

/**
 * Clamp a requested cap into the allowed range [1, MAX_COLD_PER_INBOX] for storage.
 * Unset / non-numeric / non-positive requests fall back to the safe default.
 */
export function clampCap(requested?: number): number {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return COLD_PER_INBOX;
  return Math.max(1, Math.min(Math.floor(n), MAX_COLD_PER_INBOX));
}
