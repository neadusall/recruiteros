/**
 * RecruitersOS · House-voice failsafe — NO dashes in outbound copy.
 *
 * House rule: outbound copy never contains a dash of any kind (em "—", en "–", or
 * hyphen "-"); compounds are written as separate words. The generators are also
 * instructed to avoid them, but instructions are not a guarantee — so this is the
 * HARD guard applied at every content-output boundary (content-library render, the
 * MPC model, and the LLM message sanitizer). A dash can never reach a recipient
 * regardless of where the copy came from.
 *
 * URLs are protected so booking links (e.g. .../talent-intro) keep their hyphens.
 */

const URL_SPLIT = /(https?:\/\/\S+)/g;

/** Strip every dash from prose, leaving URLs untouched. Idempotent. */
export function stripDashes(text: string): string {
  if (!text) return text;
  return text
    .split(URL_SPLIT)
    .map((part, i) => {
      if (i % 2 === 1) return part; // URL segment — leave exactly as is
      return part
        // Leading list bullets "- item" -> "• item": keep the list, drop the dash.
        .replace(/^([ \t]*)[-–—][ \t]+/gm, "$1• ")
        .replace(/\s*[—–]\s*/g, ", ")   // em/en dash -> comma
        .replace(/(\w)-(\w)/g, "$1 $2") // intra-word hyphen -> space (revenue-cycle -> revenue cycle)
        .replace(/\s-\s/g, " ")          // spaced hyphen -> space
        .replace(/-/g, " ")              // any remaining hyphen -> space
        .replace(/ ,/g, ",")
        .replace(/,{2,}/g, ",")
        .replace(/[ \t]{2,}/g, " ");
    })
    .join("");
}

/** True if any dash survives (em/en/hyphen) outside a URL — for tests/assertions. */
export function hasDash(text: string): boolean {
  return text
    .split(URL_SPLIT)
    .filter((_p, i) => i % 2 === 0)
    .some((p) => /[—–-]/.test(p));
}
