/**
 * RecruiterOS · BD · MPC (Most Placeable Candidate) — the model
 *
 * SCOPE: BUSINESS DEVELOPMENT ONLY. MPC reaches a hiring company with a candidate.
 * Candidate (recruiting) outreach is a deliberately separate model, built later;
 * nothing here should be reused for it. The A/B experiment + competitor grounding
 * this feeds are BD-only too (see lib/response/router isBdMotion gate).
 *
 * The MPC play: instead of pitching recruiting services, you lead with a SPECIFIC,
 * in-demand candidate you represent who fits the target company's hiring need. It
 * converts because it is value-first (you bring talent, not an ask) and timely
 * (anchored to their real signal).
 *
 * This module is the MODEL behind that play — the structured layer the LLM
 * messenger (./mpcMessaging) and the deterministic drafter both sit on:
 *   1. placeability(c)        — score WHY this candidate is "most placeable" (0..100)
 *   2. anonymizedTeaser(c)    — the identity-safe, compelling blurb to lead with
 *   3. matchScore(c, target)  — how well the MPC fits a given company/signal
 *   4. renderMpcOutreach(...) — deterministic, best-practice multi-channel copy
 *   5. mpcLeadCandidate(c)    — the anonymized string to feed generateMpcMessage
 *
 * ETHICS (non-negotiable, inherited from the house truth rule): a candidate is
 * NEVER marketed without explicit consent; the teaser is anonymized (no name, and
 * employer names abstracted to caliber) so identity is protected in a small market;
 * nothing is ever fabricated — every line is built only from provided facts.
 */

import type { JobFunction, Seniority } from "../signals/filters";
import type { SignalType } from "../signals/types";
import { SIGNAL_ANGLES } from "../content/library";
import { stripDashes } from "../text/dashes";

/* ------------------------------- candidate ------------------------------ */

export interface MpcCandidate {
  id: string;
  /** Private — used for matching/teaser construction, NEVER emitted in outreach. */
  fullName?: string;
  function: JobFunction;
  seniority: Seniority;
  industry?: string;
  yearsExperience?: number;
  currentTitle?: string;
  /** Real employers (used to gauge caliber). Abstracted to a descriptor in the teaser. */
  employers?: string[];
  /** Optional hand-written caliber descriptor, e.g. "two top-tier payments companies". */
  employerCaliber?: string;
  /** Real, candidate-verified wins. Used verbatim-ish; never embellished. */
  wins?: string[];
  skills?: string[];
  /** Why they're genuinely exploring a move — the engine of placeability. */
  reasonForMove?: string;
  desiredRole?: string;
  comp?: { current?: number; target?: number; marketMin?: number; marketMax?: number };
  location?: string;
  remote?: boolean;
  /** Notice period in days (0 = available now). */
  availabilityDays?: number;
  /** ETHICS GATE: explicit consent to represent + market this person. */
  consentToRepresent: boolean;
  /** Exclusive to us (lower risk, stronger story). */
  exclusivity?: boolean;
  references?: boolean;
  /** Already in process elsewhere — REAL, honest momentum (not fabricated scarcity). */
  interviewing?: boolean;
}

/* ----------------------------- placeability ----------------------------- */

export interface PlaceabilityScore {
  score: number;            // 0..100
  band: "A" | "B" | "C" | "blocked";
  components: Record<string, number>;
  reasons: string[];        // what makes them placeable
  blockers: string[];       // what stops us marketing them now
  marketable: boolean;      // false => do not generate outreach
}

/** Functions/seniorities most in-demand for fast placement (heuristic, tunable). */
const HOT_FUNCTIONS = new Set<JobFunction>(["engineering", "data", "sales", "product"]);
const PLACEABLE_SENIORITY: Partial<Record<Seniority, number>> = {
  mid: 14, senior: 18, lead: 18, manager: 16, director: 14, vp: 10, c_level: 6, founder: 4, junior: 8, intern: 3,
};

/**
 * Score why a candidate is the MOST placeable — and surface hard blockers. The
 * weights encode recruiting best practice: in-demand profile, real motivation,
 * availability, comp realism, low risk, honest momentum, and proof.
 */
export function placeability(c: MpcCandidate): PlaceabilityScore {
  const comp: Record<string, number> = {};
  const reasons: string[] = [];
  const blockers: string[] = [];

  // Hard gate: no consent => not marketable, full stop.
  if (!c.consentToRepresent) blockers.push("No consent to represent — cannot market this candidate.");

  // Demand: hot function + placeable seniority (max ~35).
  comp.demand = (HOT_FUNCTIONS.has(c.function) ? 17 : 9) + (PLACEABLE_SENIORITY[c.seniority] ?? 8);
  if (HOT_FUNCTIONS.has(c.function)) reasons.push(`${c.function} talent is in high demand`);

  // Caliber: strong pedigree (max 15).
  const emp = c.employers?.length ?? 0;
  comp.caliber = c.employerCaliber ? 13 : Math.min(emp * 6, 15);
  if (comp.caliber >= 10) reasons.push("strong, recognizable pedigree");

  // Motivation: a clear, real reason to move is the engine of placeability (max 15).
  comp.motivation = c.reasonForMove ? (c.desiredRole ? 15 : 11) : 4;
  if (c.reasonForMove) reasons.push("clear, genuine reason for the move");
  else blockers.push("No stated reason for the move — placeability is weak without real motivation.");

  // Availability: sooner is stronger (max 15).
  const days = c.availabilityDays ?? 60;
  comp.availability = days <= 0 ? 15 : days <= 14 ? 13 : days <= 30 ? 10 : days <= 60 ? 6 : 3;
  if (days <= 30) reasons.push(days <= 0 ? "available immediately" : `available in ~${days} days`);

  // Comp realism: target within market band (max 10).
  const t = c.comp?.target, lo = c.comp?.marketMin, hi = c.comp?.marketMax;
  if (t != null && lo != null && hi != null) {
    comp.comp = t <= hi ? (t >= lo ? 10 : 8) : 3;
    if (t > hi) blockers.push("Comp target above market band — placement risk.");
    else reasons.push("comp expectations are realistic");
  } else comp.comp = 6; // unknown — neutral
  // Momentum + low risk (max 10).
  comp.momentum = (c.interviewing ? 5 : 0) + (c.exclusivity ? 3 : 0) + (c.references ? 2 : 0);
  if (c.interviewing) reasons.push("already interviewing elsewhere — real momentum");
  if (c.exclusivity) reasons.push("exclusive to us");

  // Proof: real wins (max 15).
  comp.proof = Math.min((c.wins?.length ?? 0) * 8, 15);
  if ((c.wins?.length ?? 0) > 0) reasons.push("concrete, verifiable wins to lead with");

  let score = Math.round(Object.values(comp).reduce((s, n) => s + n, 0));
  score = Math.max(0, Math.min(100, score));

  const marketable = c.consentToRepresent && score >= 45 && comp.motivation >= 8;
  const band: PlaceabilityScore["band"] = !c.consentToRepresent ? "blocked"
    : score >= 75 ? "A" : score >= 55 ? "B" : "C";

  return { score, band, components: comp, reasons, blockers, marketable };
}

/* ------------------------------- teaser --------------------------------- */

const SENIORITY_WORD: Partial<Record<Seniority, string>> = {
  intern: "junior", junior: "junior", mid: "", senior: "senior", lead: "lead",
  manager: "manager-level", director: "director-level", vp: "VP-level", c_level: "executive", founder: "founder-level",
};
const FUNCTION_WORD: Record<JobFunction, string> = {
  engineering: "engineer", product: "product leader", design: "designer", data: "data specialist",
  sales: "sales leader", marketing: "marketing leader", finance: "finance leader", operations: "operations leader",
  people_hr: "people/talent leader", customer_success: "customer success leader", legal: "legal counsel",
  executive: "executive", other: "professional",
};

/** Abstract employer names to a caliber descriptor so identity stays protected. */
function caliberPhrase(c: MpcCandidate): string {
  if (c.employerCaliber) return c.employerCaliber;
  const n = c.employers?.length ?? 0;
  const sector = c.industry ? c.industry.replace(/_/g, " ") : "industry";
  if (n >= 2) return `${n >= 3 ? "several" : "two"} well-known ${sector} companies`;
  if (n === 1) return `a well-known ${sector} company`;
  return "";
}

/**
 * The identity-safe, compelling one-to-two sentence blurb the outreach leads with.
 * Built only from real fields; never names the person, abstracts employers. Returns
 * "" when the candidate is not marketable (no consent / too thin).
 */
export function anonymizedTeaser(c: MpcCandidate): string {
  if (!c.consentToRepresent) return "";
  const sen = SENIORITY_WORD[c.seniority] ?? "";
  const role = FUNCTION_WORD[c.function] ?? "professional";
  const yrs = c.yearsExperience ? `${c.yearsExperience}+ years` : "";
  const cal = caliberPhrase(c);

  const lead = ["a", sen, role].filter(Boolean).join(" ");
  let s = lead;
  if (yrs && cal) s += ` with ${yrs} across ${cal}`;
  else if (yrs) s += ` with ${yrs} of experience`;
  else if (cal) s += ` who has worked at ${cal}`;
  const win = c.wins?.[0];
  if (win) s += `, who ${win.replace(/^(led|drove|built|cut|shipped|grew|owned)/i, (m) => m.toLowerCase())}`;
  s += ".";

  const want = c.desiredRole ? ` Exploring ${c.desiredRole}` : " Open to the right move";
  const why = c.reasonForMove ? ` because ${c.reasonForMove}` : "";
  const avail = (c.availabilityDays ?? 60) <= 0 ? ", available now" : (c.availabilityDays != null ? `, available in about ${c.availabilityDays} days` : "");
  s += `${want}${why}${avail}.`;
  return s;
}

/** A SHORT teaser for tight channels (LinkedIn connect note), so it never truncates
 *  mid-word. e.g. "a senior fintech engineer (8 yrs), open to platform leadership". */
export function compactTeaser(c: MpcCandidate): string {
  if (!c.consentToRepresent) return "";
  const sen = SENIORITY_WORD[c.seniority] ?? "";
  const role = FUNCTION_WORD[c.function] ?? "professional";
  const ind = c.industry ? c.industry.replace(/_/g, " ") + " " : "";
  const yrs = c.yearsExperience ? ` (${c.yearsExperience} yrs)` : "";
  const want = c.desiredRole ? `, open to ${c.desiredRole.replace(/^series [a-z+]+\s*/i, "").trim()}` : ", open to the right move";
  const lead = ["a", sen, ind + role].filter(Boolean).join(" ").replace(/\s+/g, " ");
  return `${lead}${yrs}${want}`.slice(0, 150);
}

/** The anonymized string to hand to generateMpcMessage(lead.candidate). */
export function mpcLeadCandidate(c: MpcCandidate): string | undefined {
  const t = anonymizedTeaser(c);
  return t || undefined;
}

function article(s: string): string {
  return /^[aeiou]/i.test(s.trim()) ? "an" : "a";
}

/* ------------------------------- matching ------------------------------- */

export interface MpcTarget {
  function?: JobFunction;
  seniority?: Seniority;
  industry?: string;
  signalType?: SignalType | string;
  roles?: string[];
}

const SENIORITY_RANK: Record<Seniority, number> = {
  intern: 0, junior: 1, mid: 2, senior: 3, lead: 4, manager: 4, director: 5, vp: 6, c_level: 7, founder: 7,
};

/** How well an MPC fits a target company/role/signal (0..100). Function fit dominates,
 *  then seniority proximity, industry, and whether the signal implies this need. */
export function matchScore(c: MpcCandidate, target: MpcTarget): number {
  let s = 0;
  // Function (max 45): exact, else partial if the open roles mention the function word.
  if (target.function && target.function === c.function) s += 45;
  else if (target.roles?.some((r) => r.toLowerCase().includes(FUNCTION_WORD[c.function].split(" ")[0]))) s += 28;
  else if (!target.function && !target.roles?.length) s += 18; // unknown need — neutral credit
  // Seniority proximity (max 25).
  if (target.seniority) {
    const d = Math.abs(SENIORITY_RANK[c.seniority] - SENIORITY_RANK[target.seniority]);
    s += Math.max(0, 25 - d * 8);
  } else s += 14;
  // Industry (max 15).
  if (target.industry && c.industry && target.industry.toLowerCase().includes(c.industry.toLowerCase())) s += 15;
  else if (!target.industry) s += 8;
  // Signal relevance (max 15): hiring-intent signals strongly imply a real need.
  const hot = new Set(["job_posting", "hiring_velocity", "job_repost", "evergreen_role", "headcount_growth", "funding_round", "department_head_change", "exec_hire", "office_expansion"]);
  if (target.signalType && hot.has(String(target.signalType))) s += 15;
  else if (target.signalType) s += 7;
  return Math.max(0, Math.min(100, Math.round(s)));
}

/* --------------------------- deterministic copy ------------------------- */

export interface MpcOutreach {
  ok: boolean;
  blocked?: string;
  email?: { subject: string; body: string };
  linkedin_connection?: string;
  linkedin_message?: string;
  voicemail?: string;
}

export interface MpcRenderOpts {
  firstName?: string;
  company?: string;
  signalType?: SignalType | string;
  motion?: "bd";
  sender?: string;
  callbackNumber?: string;
  calendarLink?: string;
}

function signalOpener(company: string, signalType?: SignalType | string): string {
  const a = signalType ? SIGNAL_ANGLES[signalType as SignalType] : undefined;
  const line = a?.bd ?? "Something about what your team is building made this worth a note.";
  return line.replace(/\{company\}/g, company).replace(/\{[^}]+\}/g, "").replace(/\s{2,}/g, " ").trim();
}

/**
 * Deterministic, best-practice MPC outreach (the instant, no-LLM path that mirrors
 * the variant tested in bd/experiment). Structure per channel: signal hook ->
 * lead with the anonymized candidate -> low-friction ask. Refuses without consent.
 */
export function renderMpcOutreach(c: MpcCandidate, opts: MpcRenderOpts = {}): MpcOutreach {
  const place = placeability(c);
  if (!place.marketable) {
    return { ok: false, blocked: place.blockers[0] ?? "Candidate is not marketable yet (consent / motivation / fit)." };
  }
  const first = opts.firstName || "there";
  const company = opts.company || "your team";
  const sender = opts.sender || "{{sender}}";
  const cb = opts.callbackNumber || "{{callback_number}}";
  const teaser = anonymizedTeaser(c);
  const short = compactTeaser(c);
  const hook = signalOpener(company, opts.signalType);
  const roleWord = FUNCTION_WORD[c.function];
  const senRole = [SENIORITY_WORD[c.seniority], roleWord].filter(Boolean).join(" ");

  // House-voice failsafe on every field: never emit a dash.
  return {
    ok: true,
    email: {
      subject: stripDashes(`${first}, ${article(senRole)} ${senRole} worth meeting`),
      body: stripDashes(
        `Hi ${first},\n\n` +
        `${hook}\n\n` +
        `I'm representing ${teaser}\n\n` +
        `Given that, ${company} came to mind. Worth a short call to walk the profile, or I can send a one page summary. No pressure either way.\n\n` +
        `${sender}`,
      ),
    },
    linkedin_connection: stripDashes(
      `${first}, I represent ${short}. Given what ${company} is building, worth connecting.`).slice(0, 250),
    linkedin_message: stripDashes(
      `${first}, ${hook} I'm working with ${teaser} They would fit what you're building at ${company}. ` +
      `Open to a quick look, or should I send a one page summary?`),
    // Voicemail stays ~20-25s, so it leads with the COMPACT teaser, not the full one.
    voicemail: stripDashes(
      `Hi ${first}, this is ${sender}. ${hook} I'm representing ${short}, and ${company} came to mind. ` +
      `If it's useful, I can send a short summary or grab five minutes. Reach me at ${cb}. Thanks.`),
  };
}
