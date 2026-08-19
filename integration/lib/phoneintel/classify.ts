/**
 * RecruitersOS · Phone Intelligence · Rule-based classifier
 *
 * The cost-control spine (spec §14, §39): before any model is consulted, a
 * deterministic rule engine tries to classify what we just heard and decide the
 * next keystroke. Only genuinely ambiguous prompts fall through to an LLM. Every
 * function here is pure and unit-tested; none makes a network call.
 *
 * ── The IVR variation catalog this engine covers ────────────────────────────
 * Reaching a SPECIFIC named person behind a corporate switchboard means handling
 * every shape a phone tree takes. The functions below are the deterministic
 * readers for each; navigation.ts composes them into a single move, always using
 * the target's FIRST + LAST name as the benchmark.
 *
 *  1. Answer type        — IVR menu / named VM / generic VM / receptionist /
 *                          hold queue / after-hours / security gate. (classifyAnswer)
 *  2. Menu options        — "press N for X", "for X press N", "to reach X press N",
 *                          "press N to be connected to X", "dial N for X", star/pound
 *                          keys, digit words ("press one"). (extractMenuOptions)
 *  3. Directory trigger   — "for the company directory press N", "dial by name". (isDirectoryOption)
 *  4. Directory format    — first N of last / spell last / last then first / first
 *                          then last / first N of first-or-last / speech / #-terminated /
 *                          "for Q press 7" letter hints. (parseDirectoryInstruction)
 *  5. Extension dial-ahead— "if you know your party's extension, dial it now". (detectExtensionInvite)
 *  6. Multi-match list    — "for John Smith press 1, for John Smyth press 2". (matchNamedOptions)
 *  7. Confirmation        — "did you say John Smith? press 1 for yes". (parseConfirmation)
 *  8. Connecting/progress — "please hold while I connect you to John Smith". (detectConnecting)
 *  9. Department fallback — no directory, but "press 3 for sales" and target is in
 *                          sales. (departmentForTitle + matchDepartmentOption)
 * 10. Operator fallback   — reach a human who can transfer by name. (isOperatorOption)
 */

import type { DirectorySpec } from "./keypad";

export type AnswerClass =
  | "ivr"
  | "voicemail_generic"
  | "voicemail_named"
  | "human_receptionist"
  | "human_generic"
  | "hold_queue"
  | "after_hours"
  | "security_gate"
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

/* ------------------------------ phrase banks ----------------------------- */

const IVR_PHRASES = [
  "thank you for calling", "thanks for calling", "for sales", "for support",
  "for billing", "for customer service", "for technical support", "for new patients",
  "if you know your party", "your party's extension", "your parties extension",
  "press one", "press 1", "press two", "press 2", "press three", "press 3",
  "please listen carefully", "our menu has changed", "menu options have changed",
  "say the name", "company directory", "employee directory", "staff directory",
  "dial by name", "for the company directory", "to reach", "para espanol",
  "for english", "you have reached the main", "please hold while", "at the main menu",
  "using your keypad", "at any time", "returning to the main menu", "main menu",
  "to repeat this menu", "to repeat these options", "press pound", "press star",
  "press the star key", "press the pound key", "for a directory of", "to access the directory",
  "enter the extension", "if you know the extension", "for a company directory",
];

const VOICEMAIL_PHRASES = [
  "leave a message", "after the tone", "after the beep", "at the tone",
  "unavailable right now", "not available to take your call", "record your message",
  "please leave your name", "your call has been forwarded", "voicemail box",
  "is unavailable", "away from my desk", "when you are finished you may hang up",
  "not able to take your call", "please leave a detailed message", "leave your name and number",
  "has a voicemail", "reached the voicemail", "reached the voice mail", "to leave a message",
  "begin recording", "start recording after", "at the sound of the tone",
];

const RECEPTIONIST_PHRASES = [
  "how may i direct your call", "how can i help you", "how may i help you",
  "how can i direct your call", "who would you like to speak", "who are you trying to reach",
  "who are you calling for", "how may i assist", "how may i assist you",
  "thanks for calling", "thank you for calling", "may i help you", "front desk",
  "this is", // gated by human vs machine below
];

const HOLD_PHRASES = [
  "your call is important", "please continue to hold", "all of our representatives",
  "all our agents are", "the next available", "your call will be answered",
  "please stay on the line", "estimated wait", "your call is being held",
  "thank you for your patience", "please remain on the line",
];

const AFTERHOURS_PHRASES = [
  "our office is closed", "our offices are closed", "currently closed",
  "outside of our business hours", "outside of our normal business hours",
  "regular business hours are", "our hours of operation", "please call back during",
  "we are closed", "closed for the day", "closed for the holiday",
];

/** Robocall/spam gates that make a human prove themselves before ringing through. */
const SECURITY_GATE_PHRASES = [
  "to prove you are a human", "to prove you're a human", "press 1 to continue",
  "press one to continue", "to be connected press", "if you are a real person",
  "to verify you are a person", "enter the number you hear", "press pound to continue",
];

/** "you have reached John Smith" / "you've reached Jane Doe, Director of ..." */
const NAMED_VM_RE =
  /(?:you(?:'ve| have)? reached|this is|you have reached|the (?:voice ?mail|office) of|reached the (?:voice ?mail|office|desk) of)\s+([a-z][a-z'.\-]+(?:\s+[a-z][a-z'.\-]+){0,2})/i;

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

  const secHit = SECURITY_GATE_PHRASES.find((p) => t.includes(p));
  const ahHit = AFTERHOURS_PHRASES.find((p) => t.includes(p));
  const holdHit = HOLD_PHRASES.find((p) => t.includes(p));
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
  // After-hours and hold are checked before IVR because they can share cue words.
  if (ahHit) return { class: "after_hours", confidence: 0.85, matched: ahHit, source: "rule" };
  if (secHit) return { class: "security_gate", confidence: 0.8, matched: secHit, source: "rule" };
  if (holdHit && !ivrHit) return { class: "hold_queue", confidence: 0.8, matched: holdHit, source: "rule" };
  // IVR menus tend to stack multiple "press/for" cues; a single cue is weaker.
  if (ivrHit) {
    const cues = IVR_PHRASES.filter((p) => t.includes(p)).length;
    return { class: "ivr", confidence: Math.min(0.97, 0.7 + cues * 0.08), matched: ivrHit, source: "rule" };
  }
  const recHit = RECEPTIONIST_PHRASES.find((p) => t.includes(p));
  if (isMachine === false || (recHit && isMachine !== true)) {
    if (recHit && recHit !== "this is" && recHit !== "thanks for calling" && recHit !== "thank you for calling") {
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
  /** DTMF token to press (0-9, * or #). */
  digit: string;
  /** What it routes to, normalized. */
  meaning: string;
  /** Whether this looks like the company/employee directory (routing priority). */
  isDirectory: boolean;
  /** Whether this looks like a live operator / receptionist. */
  isOperator: boolean;
}

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  star: "*", asterisk: "*", pound: "#", hash: "#", "the pound sign": "#",
};

const DIRECTORY_RE =
  /\bdirectory\b|dial\s+by\s+name|dial[-\s]?by[-\s]?name|find\s+(?:an?\s+)?(?:employee|person|individual)|reach\s+(?:a\s+)?(?:specific|particular)\s+(?:person|individual|employee)|\bby\s+name\b|spell(?:ing)?\s+(?:the\s+)?(?:name|last\s+name)|name\s+of\s+the\s+(?:person|party|individual)/i;

const OPERATOR_RE =
  /operator|receptionist|reception\b|front\s+desk|switchboard|an?\s+(?:live\s+)?agent|a\s+representative|attendant|speak\s+(?:to|with)\s+(?:someone|a\s+person|an?\s+operator)|remain\s+on\s+the\s+line\s+for/i;

/** Map a spoken digit token (numeral, word, star/pound) to a DTMF token. */
function digitOf(raw: string): string {
  const r = (raw || "").toLowerCase().trim();
  if (DIGIT_WORDS[r] != null) return DIGIT_WORDS[r];
  if (r === "*" || r.includes("star") || r.includes("asterisk")) return "*";
  if (r === "#" || r.includes("pound") || r.includes("hash")) return "#";
  const d = r.replace(/[^0-9]/g, "");
  return d;
}

const DIGIT_TOKEN = "([0-9]|zero|one|two|three|four|five|six|seven|eight|nine|star|asterisk|pound|hash|\\*|#)";
const MEANING = "([a-z0-9 '&/\\-]{2,70}?)";

/**
 * Extract menu options from a transcript across the common phrasings:
 *   "for X, press N"            "press N for X"
 *   "to reach/speak with X press N"   "press N to reach/be connected to X"
 *   "dial N for X"              "for X, dial N"
 * Handles digit words ("press one") and the star/pound keys. Later, richer
 * phrasings win over terse ones for the same digit.
 */
export function extractMenuOptions(transcript: string): MenuOption[] {
  const text = transcript || "";
  const opts: Record<string, MenuOption> = {};
  // First writer wins for a given digit, so the earlier (more reliable) pattern
  // holds. This matters because "press 1 for support, press 3 for sales" also
  // lets the looser "for <meaning>, press <digit>" pattern read "for support,
  // press 3" — running the exact "press N for X" forms FIRST pins 3=sales before
  // the looser form can mislabel it.
  const add = (digitRaw: string, meaning: string) => {
    const digit = digitOf(digitRaw);
    if (!digit || opts[digit]) return;
    const m = meaning.trim().replace(/\s+/g, " ").replace(/[,.;:]+$/, "").slice(0, 80);
    if (!m) return;
    opts[digit] = { digit, meaning: m, isDirectory: DIRECTORY_RE.test(m), isOperator: OPERATOR_RE.test(m) };
  };

  // Each tuple: [regex, digit-group index, meaning-group index]. Ordered most
  // reliable first (digit-then-meaning forms), loosest last.
  const patterns: Array<[RegExp, number, number]> = [
    // "press/dial <digit> for/to <meaning>"
    [new RegExp(`\\b(?:press|dial|enter|select|choose)\\s+(?:the\\s+)?${DIGIT_TOKEN}\\s+(?:for|to)\\s+${MEANING}(?=[,.;]|\\bpress\\b|\\bdial\\b|\\bor\\b|$)`, "gi"), 1, 2],
    // "press <digit> to reach/speak with/be connected to <meaning>"
    [new RegExp(`\\bpress\\s+(?:the\\s+)?${DIGIT_TOKEN}\\s+to\\s+(?:reach|speak\\s+(?:to|with)|be\\s+connected\\s+(?:to)?|connect\\s+(?:to|with))\\s+${MEANING}(?=[,.;]|\\bpress\\b|\\bor\\b|$)`, "gi"), 1, 2],
    // "for <meaning>, (please) press/dial <digit>"  |  "to <meaning>, press <digit>"
    [new RegExp(`\\b(?:for|to)\\s+${MEANING}[,]?\\s+(?:please\\s+)?(?:press|dial|enter|select|choose)\\s+(?:the\\s+)?${DIGIT_TOKEN}`, "gi"), 2, 1],
    // "if you'd like/want <meaning>, press <digit>"
    [new RegExp(`\\bif\\s+you(?:'d|\\s+would)?\\s+(?:like|want)\\s+(?:to\\s+)?${MEANING}[,]?\\s+press\\s+(?:the\\s+)?${DIGIT_TOKEN}`, "gi"), 2, 1],
  ];

  for (const [re, dg, mg] of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) add(m[dg], m[mg]);
  }
  return Object.values(opts).sort((a, b) => a.digit.localeCompare(b.digit));
}

/** Does this menu offer a dial-by-name / company directory option? Returns its digit. */
export function directoryOptionDigit(transcript: string): string | undefined {
  return extractMenuOptions(transcript).find((o) => o.isDirectory)?.digit;
}

/** Does this menu offer an operator / receptionist? Returns its digit (falls back to 0). */
export function operatorOptionDigit(transcript: string): string | undefined {
  return extractMenuOptions(transcript).find((o) => o.isOperator)?.digit;
}

/* ----------------------- directory instruction parse ----------------------- */

/**
 * Parse the directory's own instruction into a machine spec (spec §9 A-F),
 * across the real formats a dial-by-name directory uses:
 *   "enter the first three letters of the last name"     -> last / 3 / dtmf
 *   "enter the first few letters of the last name"        -> last / 3 / dtmf (few≈3)
 *   "spell the person's last name"                        -> last / full / dtmf
 *   "enter the last name followed by the first name"      -> lastfirst / full / dtmf
 *   "enter the first name then the last name"             -> firstlast / full / dtmf
 *   "enter the first few letters of the first or last name"-> last / 3 / dtmf (last preferred)
 *   "say the first and last name"                          -> firstlast / full / speech
 *   "enter your party's extension"                         -> { extension: true }
 * "for the letters Q or Z use 7 or 9" hints are ignored — the keypad already
 * maps Q->7 and Z->9 (US E.161), so keying the name works unchanged.
 */
export function parseDirectoryInstruction(transcript: string): DirectorySpec | { extension: true } | null {
  const t = norm(transcript);
  if (!t) return null;

  // Pure extension entry (no name search offered here).
  if (/(?:your party|the)\s+extension|enter the extension|dial the extension|if you know your party/.test(t) &&
      !/directory|by name|spell|letters of/.test(t)) {
    return { extension: true };
  }
  // If it isn't a name-entry instruction at all, it's not a directory spec.
  if (!/letters of|spell|say the|enter the (?:name|first|last)|type the|key in|first name|last name|full name|name of the/.test(t)) {
    return null;
  }

  const speech = /\bsay\b|\bspeak\b|speak the|pronounce|say the name/.test(t);

  // Field + order. Detect an explicit order ("last then first", "first then last",
  // "last name followed by first name") before falling back to single-field.
  let field: DirectorySpec["field"];
  if (/first\s+name\s+(?:then|followed by|and then|comma)?\s*(?:the\s+)?last\s+name|first\s+and\s+last/.test(t)) {
    field = "firstlast";
  } else if (/last\s+name\s+(?:then|followed by|and then|comma)?\s*(?:the\s+)?first\s+name/.test(t)) {
    field = "lastfirst";
  } else if (/full\s+name/.test(t)) {
    field = "firstlast";
  } else if (/\bfirst\s+name\b/.test(t) && !/last\s+name/.test(t)) {
    field = "first";
  } else {
    field = "last"; // directories key on last name by default
  }

  // Length: an explicit count wins; "first few" ≈ 3; "spell"/"enter the (full) name" = full.
  const wordNum: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
  const numM = t.match(/first\s+(one|two|three|four|five|six|seven|\d+)\s+(?:letters|characters|digits)/) ||
               t.match(/\b(one|two|three|four|five|six|seven|\d+)\s+(?:letters|characters)\b/);
  let length: DirectorySpec["length"] = "full";
  if (numM) {
    const raw = numM[1];
    const n = wordNum[raw] ?? parseInt(raw, 10);
    length = Number.isFinite(n) ? n : "full";
  } else if (/first\s+few\s+(?:letters|characters)/.test(t)) {
    length = 3; // "first few letters" — 3 is the near-universal directory default
  } else if (/spell|enter the (?:full\s+)?(?:last|first|name)|type the|key in/.test(t)) {
    length = "full";
  }

  const terminator = /followed by (?:the )?pound|press pound|then pound|followed by #|followed by the hash|then the pound/.test(t) ? "#" : undefined;
  return { field, length, input: speech ? "speech" : "dtmf", ...(terminator ? { terminator } : {}) };
}

/**
 * A pass-through gate ("to continue press 1", "to be connected, press 1"). Common
 * on spam-filtered lines that make a caller act before ringing through. Returns
 * the digit to press, if a single unambiguous one is offered.
 */
export function detectContinueGate(transcript: string): string | undefined {
  const t = norm(transcript);
  const m =
    t.match(/press\s+(?:the\s+)?([0-9]|zero|one|two)\s+to\s+(?:continue|proceed|be\s+connected|go\s+ahead|reach\s+(?:the|our))/) ||
    t.match(/to\s+(?:continue|proceed|be\s+connected|go\s+ahead)\s*,?\s+(?:please\s+)?press\s+(?:the\s+)?([0-9]|zero|one|two)/);
  return m ? digitOf(m[1]) : undefined;
}

/** "if you know your party's extension, you may dial it now" — dial-ahead invite. */
export function detectExtensionInvite(transcript: string): boolean {
  const t = norm(transcript);
  return /if you know your party'?s? extension|know the extension|enter your party'?s? extension|dial (?:the )?extension (?:at any time|now)|you may dial it (?:now|at any time)|dial your party'?s? extension/.test(t);
}

/* --------------------------- connecting / progress --------------------------- */

export interface ConnectingInfo {
  connecting: boolean;
  /** The name the system says it is connecting us to, if spoken. */
  name?: string;
}

/**
 * Progress statements that are NOT action prompts — the system is transferring
 * us. "please hold while I connect you to John Smith" / "your call is being
 * transferred" / "one moment". If a name is spoken, we surface it so the caller
 * can confirm it matches the target before waiting through the transfer.
 */
export function detectConnecting(transcript: string): ConnectingInfo {
  const t = norm(transcript);
  const connecting =
    /please hold while|hold while (?:i|we) connect|connecting you|now connecting|i'?ll connect you|transferring your call|your call is being transferred|please wait while|one moment|transferring you (?:to|now)|extension is being dialed/.test(t);
  if (!connecting) return { connecting: false };
  const m = transcript.match(/(?:connect(?:ing)?\s+you\s+(?:to|with)|transferring\s+(?:you|your\s+call)\s+to|hold\s+(?:for|while\s+i\s+(?:reach|get)))\s+([a-z][a-z'.\-]+(?:\s+[a-z][a-z'.\-]+){0,2})/i);
  return { connecting: true, name: m?.[1]?.trim() };
}

/* ------------------------------ confirmation ------------------------------ */

export interface ConfirmationPrompt {
  isConfirmation: boolean;
  /** The name the system read back for us to confirm, if any. */
  name?: string;
  /** Digit that means "yes, correct" (default "1"). */
  yesDigit: string;
  /** Digit that means "no, try again", if offered. */
  noDigit?: string;
}

/**
 * "Did you say John Smith? Press 1 for yes, 2 for no." / "If this is correct,
 * press 1." / "You entered Smith. Press 1 to confirm." A directory read-back the
 * caller must accept — we press yes only when the read-back name matches the
 * target, otherwise press no to retry.
 */
export function parseConfirmation(transcript: string): ConfirmationPrompt {
  const t = norm(transcript);
  const isConfirmation =
    /did you say|is that correct|if (?:this|that) is correct|to confirm|you (?:entered|selected|said)|is this correct|if correct/.test(t);
  if (!isConfirmation) return { isConfirmation: false, yesDigit: "1" };

  const nameM = transcript.match(/(?:did you say|you (?:entered|selected|said)|looking for|is this)\s+([a-z][a-z'.\-]+(?:\s+[a-z][a-z'.\-]+){0,2})/i);

  // Yes/no digit mapping from the prompt; default yes=1. Handles "press 1 for
  // yes", "for yes press 1", and the terse "press 1 for yes, 2 for no" (where the
  // second option carries the digit without repeating "press").
  const yesM = t.match(/press\s+(?:the\s+)?([0-9]|one|two)\s+(?:for\s+)?(?:yes|to\s+confirm|if\s+(?:this|that|correct))/) ||
               t.match(/(?:yes|to\s+confirm|if\s+correct)[, ]+press\s+(?:the\s+)?([0-9]|one|two)/) ||
               t.match(/\b([0-9]|one|two)\s+for\s+yes\b/);
  const noM = t.match(/press\s+(?:the\s+)?([0-9]|one|two)\s+(?:for\s+)?(?:no|to\s+try\s+again|if\s+(?:this|that)\s+is\s+(?:incorrect|wrong))/) ||
              t.match(/(?:no|to\s+try\s+again|if\s+(?:incorrect|wrong))[, ]+press\s+(?:the\s+)?([0-9]|one|two)/) ||
              t.match(/\b([0-9]|one|two)\s+for\s+no\b/);
  return {
    isConfirmation: true,
    name: nameM?.[1]?.trim(),
    yesDigit: yesM ? digitOf(yesM[1]) : "1",
    noDigit: noM ? digitOf(noM[1]) : undefined,
  };
}

/* ------------------------- multi-match disambiguation ------------------------- */

export interface NamedOptionMatch {
  /** Best-matching option's digit, if any option name-matches the target. */
  digit?: string;
  score: number;
  detectedName?: string;
}

/**
 * A directory that found MULTIPLE people reads them as a numbered list:
 * "for John Smith press 1, for John Smyth press 2, for Jane Smith press 3."
 * We score each option's spoken name against the target (first + last as the
 * benchmark) and return the digit of the best match at/above the probable bar.
 * This is where the name benchmark earns its keep — we pick the RIGHT person.
 */
export function matchNamedOptions(
  options: MenuOption[],
  target: { first?: string; last?: string; full?: string },
  minScore = 0.72,
): NamedOptionMatch {
  let best: NamedOptionMatch = { score: 0 };
  for (const o of options) {
    // Only score options whose meaning reads like a person's name (letters +
    // spaces, 1-3 tokens), not a department ("sales", "billing department").
    const meaning = o.meaning.trim();
    if (!/^[a-z][a-z'.\-]*(?:\s+[a-z][a-z'.\-]*){0,2}$/i.test(meaning)) continue;
    if (DEPARTMENT_WORD_RE.test(meaning)) continue;
    const m = matchName(target, meaning);
    if (m.score > best.score) best = { digit: o.digit, score: m.score, detectedName: meaning };
  }
  if (best.score < minScore) return { score: best.score };
  return best;
}

/* ------------------------- department fallback routing ------------------------- */

/**
 * When there is NO dial-by-name directory, a department that fits the target's
 * title is the next best hop: reaching Sales when the target is "VP of Sales"
 * puts us with a team member who can transfer us to them by name. Conservative
 * synonym sets — we only route on a confident title→department signal.
 */
const DEPARTMENT_SYNONYMS: Record<string, string[]> = {
  sales: ["sales", "new business", "business development", "account executive", "revenue", "new customers", "new accounts"],
  marketing: ["marketing", "communications", "brand", "press", "media relations", "public relations"],
  support: ["support", "customer service", "customer support", "technical support", "help desk", "service desk", "client services"],
  billing: ["billing", "accounts receivable", "payments", "collections"],
  ap: ["accounts payable", "vendor", "procurement", "purchasing"],
  hr: ["human resources", "hr", "people", "talent", "recruiting", "recruitment", "careers", "benefits"],
  it: ["information technology", "it department", "engineering", "technology", "developers", "technical"],
  finance: ["finance", "accounting", "treasury", "controller"],
  operations: ["operations", "logistics", "fulfillment", "supply chain"],
  legal: ["legal", "compliance", "general counsel"],
  exec: ["executive", "office of the", "administration", "corporate office"],
};

const DEPARTMENT_WORD_RE =
  /\b(sales|marketing|support|billing|service|human resources|\bhr\b|recruiting|accounting|finance|operations|legal|engineering|department|reception|customer)\b/i;

/** Map a job title to a department tag, or undefined when it's not confident. */
export function departmentForTitle(title?: string): string | undefined {
  const t = norm(title || "");
  if (!t) return undefined;
  // Longest-synonym-first so "business development" beats a stray "business".
  let bestDept: string | undefined;
  let bestLen = 0;
  for (const [dept, syns] of Object.entries(DEPARTMENT_SYNONYMS)) {
    for (const s of syns) {
      if (t.includes(s) && s.length > bestLen) { bestDept = dept; bestLen = s.length; }
    }
  }
  return bestDept;
}

/** Find the menu option that routes to the target's department. Returns its digit. */
export function matchDepartmentOption(options: MenuOption[], dept?: string): string | undefined {
  if (!dept) return undefined;
  const syns = DEPARTMENT_SYNONYMS[dept];
  if (!syns) return undefined;
  for (const o of options) {
    const m = norm(o.meaning);
    if (syns.some((s) => m.includes(s))) return o.digit;
  }
  return undefined;
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
 * Last name is weighted more heavily than first. Handles "Last, First" order
 * (directory read-backs often invert), initials, and a missing first name.
 */
export function matchName(
  target: { first?: string; last?: string; full?: string },
  detected: string,
): NameMatch {
  const dToks = (detected || "").replace(/,/g, " ").trim().split(/\s+/).filter(Boolean);
  const dFirst = dToks[0] ?? "";
  const dLast = dToks.length > 1 ? dToks[dToks.length - 1] : "";

  let tFirst = (target.first || "").trim();
  let tLast = (target.last || "").trim();
  if ((!tFirst || !tLast) && target.full) {
    const tt = target.full.trim().split(/\s+/).filter(Boolean);
    if (!tFirst) tFirst = tt[0] ?? "";
    if (!tLast && tt.length > 1) tLast = tt[tt.length - 1];
  }

  // Score both natural (first..last) and inverted (last..first) orders; the
  // directory may read "Smith, John" — take whichever order fits better.
  const natLast = tLast && dLast ? tokenScore(tLast, dLast) : 0;
  const natFirst = tFirst && dFirst ? tokenScore(tFirst, dFirst) : 0;
  const invLast = tLast && dFirst ? tokenScore(tLast, dFirst) : 0;
  const invFirst = tFirst && dLast ? tokenScore(tFirst, dLast) : 0;

  const natural = natLast * 0.6 + natFirst * 0.4;
  const inverted = invLast * 0.6 + invFirst * 0.4;
  const useInverted = inverted > natural;
  const lastScore = useInverted ? invLast : natLast;
  const firstScore = useInverted ? invFirst : natFirst;

  // A strong last name alone (first not spoken) can still carry a partial.
  let score = Math.max(natural, inverted);
  if (dToks.length === 1 && tLast) score = Math.max(score, tokenScore(tLast, dFirst) * 0.8);
  score = Math.round(score * 100) / 100;

  const verdict: NameMatch["verdict"] =
    score >= 0.9 ? "match" : score >= 0.75 ? "probable" : "no_match";
  return { score, firstScore, lastScore, verdict };
}
