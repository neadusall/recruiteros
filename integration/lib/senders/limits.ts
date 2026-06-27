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
export const COLD_PER_INBOX = 2;        // cold emails/day per Email ID (HARD cap — the send limit)
export const WARMING_PER_INBOX = 10;    // Smartlead warming emails/day per Email ID (informational)
export const INBOXES_PER_DOMAIN = 50;   // Email IDs provisioned per sending domain

/** Effective cold cap for an inbox — never above the hard ceiling, whatever is stored. */
export function coldCap(storedDailyCap?: number): number {
  const n = Number(storedDailyCap);
  return Number.isFinite(n) && n > 0 ? Math.min(n, COLD_PER_INBOX) : COLD_PER_INBOX;
}
