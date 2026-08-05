/**
 * RecruitersOS · Bounce classification
 *
 * Postal (and raw SMTP) failures are not all the same, and treating them the
 * same was burning good addresses forever:
 *
 *   HARD  - the mailbox does not exist / rejected permanently (5xx). Suppress
 *           permanently and count against the domain's bounce rate.
 *   SOFT  - transient: mailbox full, greylisting, rate-limited, server hiccup
 *           (4xx). Suppress with an expiry so the address gets another chance
 *           after SOFT_BOUNCE_SUPPRESS_DAYS, and still count the bounce.
 *   HELD  - Postal held the message (content/quota/queue hold). NOT a bounce:
 *           nothing was rejected by the recipient. Recorded for visibility,
 *           never suppressed, never counted against the bounce rate.
 */

export type BounceSeverity = "hard" | "soft";

const HARD_HINTS = [
  "user unknown", "unknown user", "no such user", "does not exist",
  "no mailbox", "mailbox not found", "mailbox unavailable", "invalid recipient",
  "recipient rejected", "address rejected", "unrouteable", "unknown recipient",
  "account disabled", "account has been disabled", "address not found",
  "recipient address rejected", "550 5.1.1", "5.1.1", "5.1.10", "5.4.1",
];

const SOFT_HINTS = [
  "mailbox full", "quota", "over quota", "insufficient storage",
  "greylist", "graylist", "try again", "try later", "temporar",
  "deferred", "rate limit", "too many", "throttl", "connection timed out",
  "service unavailable", "resources", "4.2.2", "4.7.0", "4.4.1",
];

/** First SMTP status code found in a raw failure string, if any. */
export function smtpCodeOf(detail?: string): number | null {
  if (!detail) return null;
  const m = detail.match(/\b([245]\d\d)\b/);
  return m ? Number(m[1]) : null;
}

/**
 * Classify a failure detail string into hard/soft. Enhanced-status keywords win
 * over the bare code because relays often wrap a 5xx inside a 4xx retry notice.
 */
export function classifyBounce(detail?: string, postalEvent?: string): BounceSeverity {
  const text = (detail || "").toLowerCase();
  if (HARD_HINTS.some((h) => text.includes(h))) return "hard";
  if (SOFT_HINTS.some((h) => text.includes(h))) return "soft";
  const code = smtpCodeOf(text);
  if (code !== null) return code >= 500 ? "hard" : "soft";
  // No detail to go on: a Postal MessageBounced (a real DSN came back) is
  // treated as hard; a bare DeliveryFailed without detail is transient.
  return postalEvent === "MessageBounced" ? "hard" : "soft";
}

/** True when a raw SMTP send error means THE RECIPIENT was rejected (a bounce),
 *  as opposed to our own connection/auth/TLS trouble (an inbox problem). */
export function isRecipientRejection(errText: string): boolean {
  const text = errText.toLowerCase();
  if (/\b(eauth|auth|login|password|credentials|certificate|self signed|econnrefused|econnreset|etimedout|enotfound|getaddrinfo|greeting)\b/.test(text)) {
    return false;
  }
  const code = smtpCodeOf(text);
  if (code !== null && code >= 500) return HARD_HINTS.some((h) => text.includes(h)) || /recipient|rcpt|mailbox|user|address/.test(text);
  return HARD_HINTS.some((h) => text.includes(h));
}
