/**
 * RecruitersOS · Voice Drops · Phone normalization
 *
 * One job: coerce any operator-entered number into strict E.164 (e.g.
 * +14792740716) so Telnyx never 422s and stored/dialed numbers are uniform.
 * Lives in its own module so both the orchestrator (campaign.ts) and the store
 * can share it without a circular import.
 */

/**
 * Normalize any operator-entered number to strict E.164 (e.g. +14792740716) so
 * Telnyx never 422s on a "(479) 274-0716", "479-274-0716", "1 479 274 0716", or
 * "+1 (479) 274-0716" style input. NANP (US/Canada) is the default plan:
 *   - 10 digits        -> +1XXXXXXXXXX (bare local number)
 *   - 11 digits w/ "1" -> +1XXXXXXXXXX (long-distance prefix)
 * A value already carrying a "+" is trusted and just stripped of separators.
 * International numbers entered without the "+" but with a country code (11-15
 * digits) are kept as written. Returns "" when there aren't enough digits to be
 * a real number, so callers can skip un-diallable junk.
 */
export function toE164(raw: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) {
    const digits = trimmed.replace(/\D/g, "");
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : "";
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return "";
}
