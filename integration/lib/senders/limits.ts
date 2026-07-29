/**
 * RecruitersOS · Senders · HARD sending limits (provider-aware)
 *
 * The pool holds TWO kinds of Email IDs with DIFFERENT capacity models:
 *
 *   - "sending-ac": mailboxes provisioned by Sending.ac. Their model sends
 *     exactly SENDING_AC_PER_INBOX cold emails/day per mailbox, always. These
 *     NEVER ramp; the flat cap IS the product.
 *   - everything else ("own-smtp" = the internal RackNerd/Mailcow SMTP server,
 *     google, outlook, other): ramps on a warm-up curve driven by the inbox's
 *     age and status, so a freshly imported inbox can never be pushed to full
 *     volume on day one. Warming itself is handled EXTERNALLY by Smartlead.ai
 *     at WARMING_PER_INBOX/day; we never send those, we only display them.
 *
 * INBOXES_PER_DOMAIN follows cold-email deliverability practice: a small number
 * of Email IDs per sending domain. Capacity math the Send Queue shows:
 *
 *   sending-ac domain     = INBOXES_PER_DOMAIN x SENDING_AC_PER_INBOX  (3 x 2 = 6/day)
 *   internal-SMTP domain  = INBOXES_PER_DOMAIN x coldMaxPerInbox()     (3 x 20 = 60/day, fully ramped)
 *
 * Ramp curve for an ACTIVE non-Sending.ac inbox, by age since it was imported:
 *   week 1: 5/day   week 2: 10/day   week 3: 15/day   week 4+: coldMaxPerInbox()
 * A WARMING inbox stays at COLD_PER_INBOX/day until the operator activates it.
 */
export const COLD_PER_INBOX = 2;        // cold emails/day for a WARMING inbox (the day-one floor)
export const SENDING_AC_PER_INBOX = 2;  // Sending.ac's flat model: 2 cold emails/day per mailbox, never ramps
export const WARMING_PER_INBOX = 10;    // Smartlead warming emails/day per Email ID (informational)
export const INBOXES_PER_DOMAIN = 3;    // Email IDs provisioned per sending domain

const RAMP_BY_WEEK = [5, 10, 15];       // active-inbox cold cap for weeks 1..3; week 4+ = ceiling

/** The fully-ramped ceiling for internal-SMTP inboxes (cold emails/day per Email ID).
 *  Env-tunable within sane bounds; defaults to 20, the sustainable per-inbox practice. */
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

/** Effective cold cap for one inbox: provider-, status- and age-aware. */
export function coldCapFor(m: { status?: string; createdAt?: string; provider?: string }): number {
  if (m.status === "paused" || m.status === "error") return 0;
  if (m.provider === "sending-ac") return SENDING_AC_PER_INBOX; // flat, never ramps
  if (m.status === "warming") return COLD_PER_INBOX;
  const created = m.createdAt ? Date.parse(m.createdAt) : NaN;
  const ageDays = Number.isFinite(created) ? Math.max(0, (Date.now() - created) / 86_400_000) : 0;
  const week = Math.floor(ageDays / 7);
  const cap = week < RAMP_BY_WEEK.length ? RAMP_BY_WEEK[week] : coldMaxPerInbox();
  return Math.min(cap, coldMaxPerInbox());
}
