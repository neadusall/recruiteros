/**
 * RecruitersOS · Senders · HARD sending limits
 *
 * These are intentionally hard-coded, not user-tunable. Every Email ID ramps to at
 * most coldMaxPerInbox() cold emails/day, on a warm-up curve driven by the inbox's
 * age and status, so a freshly imported inbox can never be pushed to full volume on
 * day one. Warming itself is handled EXTERNALLY by Smartlead.ai at WARMING_PER_INBOX
 * /day; we never send those, we only display them for context.
 *
 * INBOXES_PER_DOMAIN follows cold-email deliverability practice: a small number of
 * Email IDs per sending domain (packing dozens onto one domain concentrates the
 * blast radius when reputation dips). Capacity math the Send Queue shows:
 *
 *   cold sends/day per domain (fully ramped) = INBOXES_PER_DOMAIN x coldMaxPerInbox()
 *   (e.g. 3 IDs x 20 = 60/domain/day)
 *
 * Ramp curve for an ACTIVE inbox, by age since it was imported:
 *   week 1: 5/day   week 2: 10/day   week 3: 15/day   week 4+: coldMaxPerInbox()
 * A WARMING inbox stays at COLD_PER_INBOX/day until the operator activates it.
 */
export const COLD_PER_INBOX = 2;        // cold emails/day for a WARMING inbox (the day-one floor)
export const WARMING_PER_INBOX = 10;    // Smartlead warming emails/day per Email ID (informational)
export const INBOXES_PER_DOMAIN = 3;    // Email IDs provisioned per sending domain

const RAMP_BY_WEEK = [5, 10, 15];       // active-inbox cold cap for weeks 1..3; week 4+ = ceiling

/** The fully-ramped ceiling (cold emails/day per Email ID). Env-tunable downward or
 *  upward within sane bounds; defaults to 20, the sustainable per-inbox practice. */
export function coldMaxPerInbox(): number {
  const n = Number(process.env.SENDER_COLD_MAX_PER_INBOX);
  return Number.isFinite(n) && n >= 1 && n <= 50 ? Math.floor(n) : 20;
}

/** Legacy clamp kept for callers holding only the stored number: never above the ceiling. */
export function coldCap(storedDailyCap?: number): number {
  const n = Number(storedDailyCap);
  const max = coldMaxPerInbox();
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : max;
}

/** Effective cold cap for one inbox: status- and age-aware warm-up ramp. */
export function coldCapFor(m: { status?: string; createdAt?: string }): number {
  if (m.status === "warming") return COLD_PER_INBOX;
  if (m.status === "paused" || m.status === "error") return 0;
  const created = m.createdAt ? Date.parse(m.createdAt) : NaN;
  const ageDays = Number.isFinite(created) ? Math.max(0, (Date.now() - created) / 86_400_000) : 0;
  const week = Math.floor(ageDays / 7);
  const cap = week < RAMP_BY_WEEK.length ? RAMP_BY_WEEK[week] : coldMaxPerInbox();
  return Math.min(cap, coldMaxPerInbox());
}
