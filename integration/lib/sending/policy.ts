/**
 * RecruitersOS · Sending policy (single source of truth)
 *
 * Every deliverability threshold used by the governor, the health score, the
 * Email ID health guard and the outbound capacity model lives HERE, so the
 * stack can never disagree with itself about what "too many bounces" means.
 *
 * Benchmarks (Anevo 650k cold-email study + Google/Yahoo bulk-sender rules):
 *   healthy cold list        < 1% bounce
 *   hard stop                > 2% bounce (list hygiene failed; stop and fix)
 *   complaint ceiling        > 0.1% (the #1 reputation killer)
 *   Google spam-rate ceiling > 0.3% (Postmaster's own red line)
 */

/** Bounce rate that flags a WARNING on health surfaces (approaching the limit). */
export const BOUNCE_WARN_RATE = 0.01;

/** Bounce rate that trips an automatic pause (domain governor). */
export const BOUNCE_PAUSE_RATE = 0.02;

/** Complaint rate that trips an automatic pause. */
export const COMPLAINT_PAUSE_RATE = 0.001;

/** User-reported spam rate (percent, Google Postmaster scale) that trips a pause. */
export const SPAM_PAUSE_RATE_PCT = 0.3;

/** Minimum sends before rate rules apply to a DOMAIN (avoids small-sample noise). */
export const DOMAIN_MIN_SAMPLE = 50;

/**
 * Per-inbox auto-hold bounce rate (Email ID health guard). Looser than the
 * domain rule because per-inbox samples are small: 2 bounces in 40 sends is
 * already 5%. The domain governor remains the hard backstop.
 */
export const INBOX_BOUNCE_HOLD_RATE = 0.05;

/** Minimum sends in the guard window before the inbox bounce rule applies. */
export const INBOX_MIN_SAMPLE = 25;

/** Days a soft (transient) bounce keeps an address suppressed before retry is allowed. */
export const SOFT_BOUNCE_SUPPRESS_DAYS = 30;

/** Days a freshly created/imported inbox must exist before it may send COLD mail. */
export function coldMinAgeDays(): number {
  const n = Number(process.env.SENDING_COLD_MIN_AGE_DAYS);
  return Number.isFinite(n) && n >= 0 && n <= 60 ? Math.floor(n) : 3;
}

export function pct(rate: number): string {
  return `${(rate * 100).toFixed(rate * 100 >= 1 ? 1 : 2)}%`;
}
