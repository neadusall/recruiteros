/**
 * RecruitersOS · BD · Copy sanitizer
 * House rule: NO dashes of any kind in outbound copy (em, en, or hyphen). Delegates
 * to the canonical failsafe in lib/text/dashes so there is ONE implementation used
 * at every output boundary (content library, MPC, and this LLM path).
 */

import { stripDashes } from "../text/dashes";

/** Strip every dash from prose while leaving URLs untouched. */
export const sanitizeDashes = stripDashes;

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
