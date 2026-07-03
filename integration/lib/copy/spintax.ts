/**
 * RecruitersOS · Copy · Spintax (send-time content diversity)
 *
 * Cold email deliverability drops when 500 recipients get a byte-identical body — mailbox providers
 * pattern-match the repetition as bulk/spam. We keep ONE approved template but write it with inline
 * spintax so every prospect receives a DIFFERENT surface form of the same message:
 *
 *     "{I saw|I noticed} {{company}} is hiring"   ->  half get "I saw", half "I noticed"
 *
 * Rules:
 *  - A spin group is `{a|b|c}` — braces with at least one `|`. A branch may be empty (`{|x}`) for
 *    optional text, and groups may nest.
 *  - `{{mergeField}}` tokens are LEFT ALONE (they're filled later by renderTouch). Merge fields may
 *    even sit INSIDE a spin branch — they're protected during expansion and restored after.
 *  - Selection is DETERMINISTIC from `seed` (usually prospectId + touch key): the same prospect always
 *    renders the same wording (idempotent resends), while different prospects diverge. No Math.random,
 *    so it's stable across retries and previews.
 */

/** FNV-1a hash of `s` -> index in [0, n). Stable, no RNG. */
function pickIndex(s: string, n: number): number {
  if (n <= 1) return 0;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % n;
}

// ASCII control-char sentinels standing in for `{{` / `}}` during expansion, so the spin parser
// (which keys off SINGLE braces) never mistakes a merge field for a spin group. NUL/SOH never appear
// in email copy, and String.fromCharCode keeps the source pure-ASCII. Restored verbatim at the end.
const OPEN = String.fromCharCode(0);
const CLOSE = String.fromCharCode(1);
const OPEN_RE = new RegExp(OPEN, "g");
const CLOSE_RE = new RegExp(CLOSE, "g");

/**
 * Expand every `{a|b}` spin group in `text`, choosing a branch deterministically from `seed`.
 * `{{mergeField}}` tokens pass through untouched (even inside a chosen branch). Innermost groups
 * resolve first, so nesting works. Returns `text` unchanged when there's nothing to spin.
 */
export function expandSpintax(text: string, seed = ""): string {
  if (!text || text.indexOf("|") === -1) return text;
  // Protect merge fields, then parse spin over single braces only.
  let s = text.replace(/\{\{/g, OPEN).replace(/\}\}/g, CLOSE);
  const group = /\{([^{}]*\|[^{}]*)\}/; // innermost group carrying a pipe
  let guard = 0;
  while (guard++ < 2000) {
    const m = s.match(group);
    if (!m || m.index === undefined) break;
    const options = m[1].split("|");
    const choice = options[pickIndex(`${seed}|${m[1]}`, options.length)] ?? "";
    // slice-splice (not String.replace) so a `$` in the chosen branch is inserted literally.
    s = s.slice(0, m.index) + choice + s.slice(m.index + m[0].length);
  }
  return s.replace(OPEN_RE, "{{").replace(CLOSE_RE, "}}");
}
