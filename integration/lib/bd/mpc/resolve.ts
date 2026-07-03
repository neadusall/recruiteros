/**
 * RecruitersOS · BD · MPC · Token resolver
 *
 * Turns a raw MPC lead into the fully-resolved merge tokens the 50 templates expect, applying every
 * fix we designed so nothing reads broken at scale:
 *
 *   - {Near_City}  -> nearest recognized metro, rendered in safe local vernacular (cities.ts)
 *   - proximityOk  -> false when the placement and the job are the SAME metro (drop "right by you")
 *   - {Open_Role}/{Job_Title} -> native insider short form (lexicon.ts)
 *   - {MH1}/{MH2}  -> native proof CLAUSES (from the JD when we have it, else the lexicon floor)
 *   - {Metric}     -> native quantified-win phrasing
 *   - {P_subj/obj/pos} -> he/she pronouns from the real candidate (never "they", so contractions work)
 *
 * `buildMpcTokens` is deterministic (seeded) so the same lead always renders the same words — idempotent
 * resends, stable previews. `extractMustHaves` is the ONE AI hook (env-gated); with no key it returns
 * the lexicon floor, so the whole system works with zero AI spend and only gets sharper with a key.
 */

import { resolveNearCity, sameMetro } from "./cities";
import { lexiconFor, nativeRole } from "./lexicon";
import { classifyTitle } from "../../signals";

export type Gender = "m" | "f";

export interface MpcLeadInput {
  firstName?: string;
  company?: string;
  /** The seat THEY likely have open (drives {Open_Role}). */
  openRole?: string;
  /** The role YOU recently placed (drives {Job_Title}); defaults to openRole's family. */
  placedRole?: string;
  /** Where you placed it (raw location; resolved to metro + vernacular for {Near_City}). */
  placementLocation?: string;
  /** Where the candidate wants to land / the job sits (raw; resolved for {Job_Location} + collision). */
  jobLocation?: string;
  competitor?: string;
  industry?: string;
  /** Real must-haves already pulled from the JD, in native phrasing (optional). */
  mustHaves?: string[];
  metric?: string;
  /** The candidate's gender, for correct he/she. Defaults to "m" only as a last resort. */
  gender?: Gender;
  yourName?: string;
}

export interface MpcTokens {
  First_Name: string;
  Company: string;
  Open_Role: string;
  /** "a"/"an" + Open_Role with the article chosen phonetically ("an AE", "a CSM", "an RN"). Use this
   *  wherever a template needs an indefinite article before the role, so it never reads "an sales rep". */
  A_Open_Role: string;
  Job_Title: string;
  /** "a"/"an" + Job_Title with a phonetic article ("a Senior AE", "an AE", "an RN"). */
  A_Job_Title: string;
  Near_City: string;
  Competitor: string;
  Industry: string;
  Job_Location: string;
  MH1: string;
  MH2: string;
  Metric: string;
  P_subj: string;
  P_obj: string;
  P_pos: string;
  Your_Name: string;
  /** false => placement and job are the same metro; templates should avoid the proximity line. */
  proximityOk: boolean;
  /** true => Near_City is a real local nickname (not just the plain metro). */
  hasVernacular: boolean;
}

/** FNV-1a -> index, so token picks are stable per lead but varied across leads. */
function pick<T>(arr: T[], seed: string): T {
  if (!arr.length) return undefined as unknown as T;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return arr[(h >>> 0) % arr.length];
}

/** Two DISTINCT picks from a bank (for MH1 + MH2), seeded. */
function pickTwo(arr: string[], seed: string): [string, string] {
  if (arr.length <= 1) return [arr[0] ?? "", arr[0] ?? ""];
  const a = pick(arr, seed + "|a");
  let b = pick(arr, seed + "|b");
  if (b === a) b = arr[(arr.indexOf(a) + 1) % arr.length];
  return [a, b];
}

const PRONOUN: Record<Gender, { subj: string; obj: string; pos: string }> = {
  m: { subj: "he", obj: "him", pos: "his" },
  f: { subj: "she", obj: "her", pos: "her" },
};

// Letters that BEGIN with a vowel SOUND when spoken aloud (so an acronym starting with them takes
// "an": an AE, an RN, an SDR, an FP&A lead, an MBA).
const LETTER_VOWEL_SOUND = new Set(["A", "E", "F", "H", "I", "L", "M", "N", "O", "R", "S", "X"]);

/**
 * UNIVERSAL post-fill fix: after merge tokens are filled, make every standalone "a"/"an" agree with
 * the word that actually follows it. This is what stops "a AE", "a ATX search", "a Uber placement"
 * once acronyms/company names land in the copy — no matter which token produced them. Preserves the
 * original capitalization; skips the HTML anchor tag `<a ...>` via the lookbehind.
 */
export function fixArticles(text: string): string {
  return text.replace(/(?<!<)\b(a|an)\s+([A-Za-z][A-Za-z0-9'&.\-]*)/gi, (_m, art: string, word: string) => {
    const correct = indefiniteArticle(word);
    const cased = art[0] === art[0].toUpperCase() ? correct.charAt(0).toUpperCase() + correct.slice(1) : correct;
    return `${cased} ${word}`;
  });
}

/** Choose "a" or "an" for a role phrase, phonetically — handles acronyms (read letter-by-letter) and
 *  the common vowel-letter/consonant-sound exceptions ("a user", "an hour"). */
function indefiniteArticle(phrase: string): "a" | "an" {
  const first = (phrase.trim().split(/\s+/)[0] || "");
  if (!first) return "a";
  if (/^[A-Z]{2,}$/.test(first) || /^[A-Z]$/.test(first)) return LETTER_VOWEL_SOUND.has(first[0]) ? "an" : "a";
  const w = first.toLowerCase();
  if (/^(uni|use|user|eu|ewe|one|once)/.test(w)) return "a";     // vowel letter, consonant sound
  if (/^(hour|honest|honor|heir)/.test(w)) return "an";          // silent h
  return /^[aeiou]/.test(w) ? "an" : "a";
}

/**
 * Resolve every MPC token for one lead. Never throws; missing inputs degrade to sane, truthful
 * defaults (e.g. no candidate specifics -> generic native proof, never a fabricated metric).
 */
export function buildMpcTokens(input: MpcLeadInput): MpcTokens {
  const seed = `${input.company || ""}|${input.openRole || ""}|${input.firstName || ""}`;
  const func = classifyTitle(input.openRole || input.placedRole || "").function;
  const lex = lexiconFor(func);

  const near = resolveNearCity(input.placementLocation);
  const jobCity = resolveNearCity(input.jobLocation);
  const proximityOk = !sameMetro(input.placementLocation, input.jobLocation) && !!near.metro;

  const openRole = nativeRole(input.openRole, func) || "the seat";
  const placedRole = nativeRole(input.placedRole || input.openRole, func) || openRole;

  // Must-haves: real JD pulls first, else the deterministic native floor.
  const jd = (input.mustHaves || []).map((s) => s.trim()).filter(Boolean);
  const [floor1, floor2] = pickTwo(lex.proofBank, seed);
  const MH1 = jd[0] || floor1;
  const MH2 = jd[1] || floor2;
  const Metric = (input.metric || "").trim() || pick(lex.metricBank, seed);

  const g = input.gender || "m";
  const pr = PRONOUN[g];

  return {
    First_Name: (input.firstName || "there").trim(),
    Company: (input.company || "your team").trim(),
    Open_Role: openRole,
    A_Open_Role: /^(the|a|an)\b/i.test(openRole) ? openRole : `${indefiniteArticle(openRole)} ${openRole}`,
    Job_Title: placedRole,
    A_Job_Title: /^(the|a|an)\b/i.test(placedRole) ? placedRole : `${indefiniteArticle(placedRole)} ${placedRole}`,
    Near_City: near.vernacular || near.metro,
    Competitor: (input.competitor || "").trim(),
    Industry: (input.industry || "").trim(),
    Job_Location: jobCity.metro || (input.jobLocation || "").trim(),
    MH1, MH2, Metric,
    P_subj: pr.subj, P_obj: pr.obj, P_pos: pr.pos,
    Your_Name: (input.yourName || "").trim(),
    proximityOk,
    hasVernacular: near.hasVernacular,
  };
}

/**
 * AI hook (env-gated): pull the two strongest must-haves from a real JD, returned as native CLAUSES
 * per the lexicon's jdStyle. Falls back to [] (so buildMpcTokens uses the lexicon floor) when there's
 * no ANTHROPIC_API_KEY or the call fails. Kept tiny + cheap: one call per role, cached upstream.
 */
export async function extractMustHaves(jobDescription: string, openRole: string): Promise<{ mustHaves: string[]; metric?: string }> {
  if (!process.env.ANTHROPIC_API_KEY || !jobDescription.trim()) return { mustHaves: [] };
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const func = classifyTitle(openRole || "").function;
    const lex = lexiconFor(func);
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model = process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";
    const resp = await client.messages.create({
      model,
      max_tokens: 300,
      system:
        `You extract the two strongest MUST-HAVES from a job posting and phrase each as a short, ` +
        `native proof clause (2 to 5 words) a candidate could OWN. ${lex.jdStyle} ` +
        `Never list tools/keywords. Never invent a number. Return STRICT JSON only: ` +
        `{ "mustHaves": ["clause","clause"], "metric": "optional native metric or empty" }`,
      messages: [{ role: "user", content: `Role: ${openRole}\n\nPosting:\n${jobDescription.slice(0, 4000)}` }],
    });
    const text = resp.content.map((c) => ("text" in c ? c.text : "")).join("");
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s < 0 || e < 0) return { mustHaves: [] };
    const j = JSON.parse(text.slice(s, e + 1)) as { mustHaves?: string[]; metric?: string };
    return { mustHaves: (j.mustHaves || []).slice(0, 2), metric: (j.metric || "").trim() || undefined };
  } catch {
    return { mustHaves: [] };
  }
}
