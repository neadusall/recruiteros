/**
 * RecruitersOS · Phone Intelligence · Keypad / DTMF name encoding
 *
 * Corporate dial-by-name directories ask the caller to key a person's name on
 * the telephone keypad (ITU E.161 mapping). This module turns a name plus a
 * parsed directory instruction into the exact DTMF string to send.
 *
 * Pure, deterministic, dependency-free — the whole point of the route cache is
 * that once a company's directory format is known, reaching a NEW person is a
 * table lookup here, not an LLM call.
 */

/** ITU E.161 letter -> digit. Q/Z map to 7/9 (US standard). */
const KEYPAD: Record<string, string> = {
  a: "2", b: "2", c: "2",
  d: "3", e: "3", f: "3",
  g: "4", h: "4", i: "4",
  j: "5", k: "5", l: "5",
  m: "6", n: "6", o: "6",
  p: "7", q: "7", r: "7", s: "7",
  t: "8", u: "8", v: "8",
  w: "9", x: "9", y: "9", z: "9",
};

/** Strip a name to keypad-encodable letters only (drop spaces, hyphens, apostrophes). */
export function lettersOnly(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z]/g, "");
}

/** Encode a run of letters to DTMF digits. Non-letters are skipped. */
export function toDtmf(letters: string): string {
  let out = "";
  for (const ch of (letters || "").toLowerCase()) {
    const d = KEYPAD[ch];
    if (d) out += d;
  }
  return out;
}

/**
 * A parsed directory instruction: which part of the name, how many characters,
 * and the input channel. Produced by classify.parseDirectoryInstruction().
 */
export interface DirectorySpec {
  /** Which name field the directory keys on. */
  field: "last" | "first" | "full" | "firstlast" | "lastfirst";
  /** How many leading characters, or "full" for the whole field. */
  length: number | "full";
  /** DTMF keypad entry vs spoken (speech directory). */
  input: "dtmf" | "speech";
  /** Some IVRs want a terminating # after the digits. */
  terminator?: "#";
}

export interface NameParts {
  first?: string;
  last?: string;
  full?: string;
}

/** Pull first/last from whatever we have. */
export function nameParts(input: NameParts): { first: string; last: string; full: string } {
  let first = (input.first || "").trim();
  let last = (input.last || "").trim();
  const full = (input.full || `${first} ${last}`).trim();
  if ((!first || !last) && full) {
    const toks = full.split(/\s+/).filter(Boolean);
    if (!first && toks.length) first = toks[0];
    if (!last && toks.length > 1) last = toks[toks.length - 1];
  }
  return { first, last, full };
}

/** The letters the spec wants keyed/spoken, before DTMF conversion. */
export function directoryLetters(spec: DirectorySpec, name: NameParts): string {
  const { first, last, full } = nameParts(name);
  let base: string;
  switch (spec.field) {
    case "first": base = first; break;
    case "full":
    case "firstlast": base = `${first}${last}`; break;
    case "lastfirst": base = `${last}${first}`; break;
    case "last":
    default: base = last; break;
  }
  const letters = lettersOnly(base);
  if (spec.length === "full" || typeof spec.length !== "number") return letters;
  return letters.slice(0, Math.max(0, spec.length));
}

/**
 * The literal DTMF to send for a directory search, or the text to speak.
 * For speech directories, returns { speak } instead of { dtmf }.
 */
export function directoryInput(
  spec: DirectorySpec,
  name: NameParts,
): { dtmf?: string; speak?: string } {
  if (spec.input === "speech") {
    const { first, last, full } = nameParts(name);
    const say =
      spec.field === "last" ? last :
      spec.field === "first" ? first :
      full;
    return { speak: say };
  }
  const letters = directoryLetters(spec, name);
  return { dtmf: toDtmf(letters) + (spec.terminator ?? "") };
}
