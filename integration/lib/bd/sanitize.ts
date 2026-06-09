/**
 * RecruiterOS · BD · Copy sanitizer
 * House rule: NO dashes of any kind in outbound copy (em, en, or hyphen). The
 * engines are also instructed to avoid them, but this guarantees it on the way out.
 * URLs are protected so booking links (e.g. .../talent-intro) keep their hyphens.
 */

const URL_SPLIT = /(https?:\/\/\S+)/g;

/** Strip every dash from prose while leaving URLs untouched. */
export function sanitizeDashes(text: string): string {
  if (!text) return text;
  return text
    .split(URL_SPLIT)
    .map((part, i) => {
      if (i % 2 === 1) return part; // URL segment — leave exactly as is
      return part
        .replace(/\s*[—–]\s*/g, ", ") // em/en dash -> comma
        .replace(/(\w)-(\w)/g, "$1 $2") // intra-word hyphen -> space (revenue-cycle -> revenue cycle)
        .replace(/\s-\s/g, " ") // spaced hyphen -> space
        .replace(/-/g, " ") // any remaining hyphen -> space
        .replace(/ ,/g, ",")
        .replace(/,{2,}/g, ",")
        .replace(/[ \t]{2,}/g, " ");
    })
    .join("");
}

/** Sanitize all outbound fields of a generated message package (structural, no type import). */
export function sanitizeMessage<
  T extends {
    email: { subject: string; body: string };
    linkedin_connection: string;
    linkedin_message: string;
    linkedin_voice_note: string;
    voicemail: string;
  },
>(m: T): T {
  return {
    ...m,
    email: { subject: sanitizeDashes(m.email.subject), body: sanitizeDashes(m.email.body) },
    linkedin_connection: sanitizeDashes(m.linkedin_connection),
    linkedin_message: sanitizeDashes(m.linkedin_message),
    linkedin_voice_note: sanitizeDashes(m.linkedin_voice_note),
    voicemail: sanitizeDashes(m.voicemail),
  };
}

/** Sanitize an optional subject + body pair. */
export function sanitizeCopy<T extends { subject?: string; body?: string; text?: string }>(o: T): T {
  return {
    ...o,
    ...(o.subject !== undefined ? { subject: sanitizeDashes(o.subject) } : {}),
    ...(o.body !== undefined ? { body: sanitizeDashes(o.body) } : {}),
    ...(o.text !== undefined ? { text: sanitizeDashes(o.text) } : {}),
  };
}
