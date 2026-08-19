/**
 * RecruitersOS · Phone Intelligence · Rule-based classifier
 *
 * The cost-control spine (spec §14, §39): before any model is consulted, a
 * deterministic rule engine tries to classify what we just heard. Only genuinely
 * ambiguous prompts fall through to an LLM. Every function here is pure and
 * unit-tested; none makes a network call.
 *
 * Inputs are transcription strings (from Telnyx real-time transcription or a
 * short record+transcribe segment). Outputs are typed classifications plus the
 * evidence that produced them, so the admin debugger can show WHY.
 */

export type AnswerClass =
  | "ivr"
  | "voicemail_generic"
  | "voicemail_named"
  | "human_receptionist"
  | "human_generic"
  | "unknown";

export interface AnswerClassification {
  class: AnswerClass;
  confidence: number;
  /** Name spoken in a named voicemail greeting, if detected. */
  detectedName?: string;
  /** The phrase that triggered the classification (evidence). */
  matched?: string;
  source: "rule";
}

const norm = (s: string) =>
  (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

const IVR_PHRASES = [
  "thank you for calling", "for sales", "for support", "for billing",
  "if you know your party", "your party's extension", "press one", "press 1",
  "press two", "press 2", "please listen carefully", "our menu has changed",
  "say the name", "company directory", "employee directory", "dial by name",
  "for the company directory", "to reach", "para espanol", "for english",
  "you have reached the main", "please hold while", "at the main menu",
];

const VOICEMAIL_PHRASES = [
  "leave a message", "after the tone", "after the beep", "at the tone",
  "unavailable right now", "not available to take your call", "record your message",
  "please leave your name", "your call has been forwarded", "voicemail box",
  "is unavailable", "away from my desk", "when you are finished you may hang up",
];

const RECEPTIONIST_PHRASES = [
  "how may i direct your call", "how can i help you", "how may i help you",
  "how can i direct your call", "who would you like to speak", "thanks for calling",
  "this is", // gated by human vs machine below
];

/** "you have reached John Smith" / "you've reached Jane Doe, Director of ..." */
const NAMED_VM_RE =
  /(?:you(?:'ve| have)? reached|this is|you have reached)\s+([a-z][a-z'.\-]+(?:\s+[a-z][a-z'.\-]+){0,2})/i;

/**
 * Classify the first audio of an answered leg (or a post-transfer greeting).
 * `isMachine` is Telnyx AMD's verdict when available — it disambiguates
 * "this is ..." (a person answering) from a named voicemail greeting.
 */
export function classifyAnswer(
  transcript: string,
  isMachine?: boolean,
): AnswerClassification {
  const t = norm(transcript);
  if (!t) return { class: "unknown", confidence: 0, source: "rule" };

  const vmHit = VOICEMAIL_PHRASES.find((p) => t.includes(p));
  const ivrHit = IVR_PHRASES.find((p) => t.includes(p));
  const named = transcript.match(NAMED_VM_RE);
  const detectedName = named?.[1]?.trim();

  // A machine greeting that names a person is the strongest signal we want.
  if ((isMachine === true || vmHit) && detectedName && !ivrHit) {
    return {
      class: "voicemail_named",
      confidence: vmHit ? 0.95 : 0.85,
      detectedName,
      matched: named?.[0],
      source: "rule",
    };
  }
  if (vmHit) {
    return { class: "voicemail_generic", confidence: 0.9, matched: vmHit, source: "rule" };
  }
  // IVR menus tend to stack multiple "press/for" cues; a single cue is weaker.
  if (ivrHit) {
    const cues = IVR_PHRASES.filter((p) => t.includes(p)).length;
    return { class: "ivr", confidence: Math.min(0.97, 0.7 + cues * 0.1), matched: ivrHit, source: "rule" };
  }
  const recHit = RECEPTIONIST_PHRASES.find((p) => t.includes(p));
  if (isMachine === false || (recHit && isMachine !== true)) {
    if (recHit && recHit !== "this is") {
      return { class: "human_receptionist", confidence: 0.85, matched: recHit, source: "rule" };
    }
    return { class: "human_generic", confidence: 0.6, matched: recHit, source: "rule" };
  }
  return { class: "unknown", confidence: 0.2, source: "rule" };
}

/* --------------------------- prompt fingerprint ------------------------- */

/**
 * Normalize an IVR prompt to a stable fingerprint (spec §13) so a repeated
 * menu is recognized without an LLM, and a CHANGED menu (e.g. "press 4" ->
 * "press 6") produces a different hash that trips rediscovery.
 */
export function promptFingerprint(transcript: string): string {
  const t = norm(transcript)
    .replace(/\b(um|uh|please|kindly|now|currently|thank you|thanks)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Keep the meaningful skeleton: words + any digits (digits carry the routing).
  const skeleton = t.split(" ").filter(Boolean).slice(0, 40).join(" ");
  let h = 5381;
  for (let i = 0; i < skeleton.length; i++) h = ((h << 5) + h + skeleton.charCodeAt(i)) | 0;
  return "p" + (h >>> 0).toString(36);
}

/* --------------------------- IVR menu options --------------------------- */

export interface MenuOption {
  /** DTMF digit to press. */
  digit: string;
  /** What it routes to, normalized. */
  meaning: string;
  /** Whether this looks like the company/employee directory (routing priority). */
  isDirectory: boolean;
  /** Whether this looks like a live operator. */
  isOperator: boolean;
}

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

const DIRECTORY_RE = /(company|employee|staff|team|personnel)\s+directory|dial\s+by\s+name|directory|find\s+(?:an\s+)?employee|by\s+name/i;
const OPERATOR_RE = /operator|reception|front desk|an? agent|representative|speak (?:to|with) someone/i;

/**
 * Extract "press N for X" / "for X press N" / "for X, press N" options from a
 * menu transcript. Handles digit words ("press one") and numerals.
 */
export function extractMenuOptions(transcript: string): MenuOption[] {
  const text = transcript || "";
  const opts: Record<string, MenuOption> = {};
  const add = (digit: string, meaning: string) => {
    if (!digit) return;
    const m = meaning.trim().replace(/\s+/g, " ").slice(0, 80);
    const isDirectory = DIRECTORY_RE.test(m);
    const isOperator = OPERATOR_RE.test(m);
    // Prefer the more descriptive meaning if we see the digit twice.
    if (!opts[digit] || m.length > opts[digit].meaning.length) {
      opts[digit] = { digit, meaning: m, isDirectory, isOperator };
    }
  };
  const digitOf = (raw: string) => DIGIT_WORDS[raw.toLowerCase()] ?? raw.replace(/[^0-9]/g, "");

  // "for <meaning>, press <digit>"  and  "to <verb> ..., press <digit>"
  const re1 = /\b(?:for|to)\s+([a-z0-9 '&\-]{2,60}?)[,]?\s+(?:please\s+)?press\s+(?:the\s+)?([0-9]|zero|one|two|three|four|five|six|seven|eight|nine)/gi;
  // "press <digit> for <meaning>"
  const re2 = /\bpress\s+(?:the\s+)?([0-9]|zero|one|two|three|four|five|six|seven|eight|nine)\s+(?:for|to)\s+([a-z0-9 '&\-]{2,60}?)(?=[,.;]|\bpress\b|\bor\b|$)/gi;

  let m: RegExpExecArray | null;
  while ((m = re1.exec(text))) add(digitOf(m[2]), m[1]);
  while ((m = re2.exec(text))) add(digitOf(m[1]), m[2]);
  return Object.values(opts).sort((a, b) => a.digit.localeCompare(b.digit));
}

/* ----------------------- directory instruction parse ----------------------- */

import type { DirectorySpec } from "./keypad";

/**
 * Parse the directory's own instruction into a machine spec (spec §9 A-F).
 * Examples:
 *   "enter the first three letters of the last name" -> last/3/dtmf
 *   "spell the person's last name"                   -> last/full/dtmf
 *   "say the first and last name"                    -> firstlast/full/speech
 *   "enter your party's extension"                   -> (extension; handled by caller)
 */
export function parseDirectoryInstruction(transcript: string): DirectorySpec | { extension: true } | null {
  const t = norm(transcript);
  if (!t) return null;

  if (/(your party|the) extension|enter the extension|if you know your party/.test(t)) {
    return { extension: true };
  }

  const speech = /\bsay\b|speak the|pronounce/.test(t);
  const field: DirectorySpec["field"] =
    /first and last|full name/.test(t) ? "firstlast" :
    /first name/.test(t) ? "first" :
    "last"; // default: directories key on last name

  // "first three letters", "first 4 letters", "three letters"
  const wordNum: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const numM = t.match(/first\s+(one|two|three|four|five|six|\d+)\s+(?:letters|characters|digits)/) ||
               t.match(/\b(one|two|three|four|five|six|\d+)\s+(?:letters|characters)\b/);
  let length: DirectorySpec["length"] = "full";
  if (numM) {
    const raw = numM[1];
    length = wordNum[raw] ?? parseInt(raw, 10);
    if (!Number.isFinite(length as number)) length = "full";
  } else if (/spell|enter the (?:full )?(?:last|first|name)|type the/.test(t)) {
    length = "full";
  }

  const terminator = /followed by the pound|press pound|then pound|followed by #/.test(t) ? "#" : undefined;
  return { field, length, input: speech ? "speech" : "dtmf", ...(terminator ? { terminator } : {}) };
}

/* ------------------------------ name matching ------------------------------ */

export interface NameMatch {
  score: number;
  firstScore: number;
  lastScore: number;
  verdict: "match" | "probable" | "no_match";
}

/** Damerau-lite Levenshtein ratio in [0,1]. */
function ratio(a: string, b: string): number {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  const dist = dp[m][n];
  return 1 - dist / Math.max(m, n);
}

/** Cheap phonetic key (Soundex) so "Stephen"/"Steven", "McDonald"/"MacDonald" align. */
export function soundex(s: string): string {
  const a = (s || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (!a) return "";
  const codes: Record<string, string> = {
    B: "1", F: "1", P: "1", V: "1",
    C: "2", G: "2", J: "2", K: "2", Q: "2", S: "2", X: "2", Z: "2",
    D: "3", T: "3", L: "4", M: "5", N: "5", R: "6",
  };
  let out = a[0];
  let prev = codes[a[0]] ?? "";
  for (let i = 1; i < a.length && out.length < 4; i++) {
    const c = codes[a[i]] ?? "";
    if (c && c !== prev) out += c;
    if (a[i] !== "H" && a[i] !== "W") prev = c;
  }
  return (out + "000").slice(0, 4);
}

function tokenScore(a: string, b: string): number {
  if (!a || !b) return 0;
  const r = ratio(a, b);
  const p = soundex(a) === soundex(b) ? 1 : 0;
  // Edit-distance dominates; phonetic equality lifts near-misses over the line.
  return Math.min(1, r * 0.75 + p * 0.35);
}

/**
 * Compare a target name against a detected/spoken name (spec §16).
 * Last name is weighted more heavily than first.
 */
export function matchName(
  target: { first?: string; last?: string; full?: string },
  detected: string,
): NameMatch {
  const dToks = (detected || "").trim().split(/\s+/).filter(Boolean);
  const dFirst = dToks[0] ?? "";
  const dLast = dToks.length > 1 ? dToks[dToks.length - 1] : "";

  let tFirst = (target.first || "").trim();
  let tLast = (target.last || "").trim();
  if ((!tFirst || !tLast) && target.full) {
    const tt = target.full.trim().split(/\s+/).filter(Boolean);
    if (!tFirst) tFirst = tt[0] ?? "";
    if (!tLast && tt.length > 1) tLast = tt[tt.length - 1];
  }

  const lastScore = tLast && dLast ? tokenScore(tLast, dLast) : (tLast && dFirst ? tokenScore(tLast, dFirst) : 0);
  const firstScore = tFirst && dFirst ? tokenScore(tFirst, dFirst) : 0;
  // Weighted: last 0.6, first 0.4, but a strong last alone can carry a partial.
  const score = Math.round((lastScore * 0.6 + firstScore * 0.4) * 100) / 100;

  const verdict: NameMatch["verdict"] =
    score >= 0.9 ? "match" : score >= 0.75 ? "probable" : "no_match";
  return { score, firstScore, lastScore, verdict };
}
