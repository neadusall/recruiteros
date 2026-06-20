/**
 * RecruitersOS · Hiring Engine
 * Target-profile inference — turn a posted role into "who owns the hire," using real org-design
 * best practices instead of a one-size-fits-all "one level up."
 *
 * THE MODEL (what good recruiters/BD reps actually reason about):
 *
 *  1. FUNCTION → leadership chain. A role rolls up its own function's ladder (eng → Eng Manager →
 *     Director → VP → CTO). We never cross functions.
 *
 *  2. ORG DEPTH SCALES WITH HEADCOUNT (span of control + layers). The SAME role is owned by a
 *     different title at different company sizes, because small orgs are flat and large orgs are
 *     deep:
 *        ~100-250  (flat / founder-led) → 2-3 layers: ICs report to the function HEAD / VP, and a
 *                                          founder/C-level signs off. There is often NO manager layer.
 *        ~250-600  (small)              → 3 layers: a Manager exists, but the Director/VP/Head owns
 *                                          the budget and the decision.
 *        ~600-2000 (mid-market)         → 4 layers: Manager → Director → VP. The Director/VP is the
 *                                          economic buyer.
 *        >2000     (enterprise)         → 5 layers: the LINE MANAGER owns the individual req.
 *
 *  3. THE ROLE'S OWN SENIORITY SHIFTS THE OWNER UP. A "VP of Eng" req is owned by the CTO/CEO; a
 *     "Director" req by the VP/C-level; an IC by the manager (adjusted for size per #2).
 *
 *  4. ECONOMIC BUYER vs LINE MANAGER. For OUTREACH we bias toward the budget owner / function head
 *     — they feel the hiring pain, can say yes, and (critically for free naming) are far more
 *     PUBLICLY FINDABLE than a first-line manager. We still return the whole chain best-first, so
 *     if the exact owner can't be named we degrade up the chain to a findable senior — who, at a
 *     small company, IS the decision-maker anyway. This is what lifts the free naming rate: in the
 *     100-5,000 band most owners are Head/VP/C-level/Founder, all of whom have public footprints.
 *
 *  5. FUNCTION → C-SUITE. The buck stops at a known exec per function (eng→CTO, sales→CRO, …).
 *
 * Pure + deterministic. Reuses classifyTitle() so "VP of Eng", "Head of Engineering", and
 * "Engineering Director" resolve the same way.
 */

import { classifyTitle, type JobFunction, type Seniority, type TitleIntel } from "../filters";

/* ------------------------------------------------------------------ */
/* Seniority ladder                                                    */
/* ------------------------------------------------------------------ */

export const SENIORITY_LADDER: Seniority[] = [
  "intern", "junior", "mid", "senior", "lead", "manager", "director", "vp", "c_level", "founder",
];

export function seniorityRank(s: Seniority): number {
  const i = SENIORITY_LADDER.indexOf(s);
  return i < 0 ? 2 /* treat unknown as mid */ : i;
}

/* ------------------------------------------------------------------ */
/* Per-function leadership LADDER (rungs, ascending)                   */
/* ------------------------------------------------------------------ */

/**
 * Each function's chain of command as 4 ascending rungs:
 *   rung 0 = first-line MANAGER, 1 = DIRECTOR, 2 = VP / HEAD, 3 = C-LEVEL.
 * Titles within a rung are listed best-first (most common phrasing leads). The selector picks the
 * rung that owns the hire (from role seniority × company size), then returns that rung and the
 * rungs above it, so the search/scorer walk the owner and their chain of command, best-first.
 */
const LADDER: Record<JobFunction, [string[], string[], string[], string[]]> = {
  engineering: [
    ["Engineering Manager", "Software Engineering Manager", "Engineering Lead"],
    ["Director of Engineering", "Engineering Director", "Senior Engineering Manager"],
    ["VP of Engineering", "VP Engineering", "Head of Engineering"],
    ["CTO", "Chief Technology Officer", "VP of Technology"],
  ],
  product: [
    ["Product Manager", "Senior Product Manager", "Group Product Manager"],
    ["Director of Product", "Product Director", "Director of Product Management"],
    ["VP of Product", "VP Product", "Head of Product"],
    ["CPO", "Chief Product Officer"],
  ],
  design: [
    ["Design Manager", "Design Lead", "UX Manager"],
    ["Director of Design", "Design Director", "Director of UX"],
    ["VP of Design", "Head of Design", "Creative Director"],
    ["Chief Design Officer", "Chief Creative Officer"],
  ],
  data: [
    ["Data Science Manager", "Analytics Manager", "Data Engineering Manager"],
    ["Director of Data", "Director of Analytics", "Director of Data Science"],
    ["VP of Data", "Head of Data", "Head of Analytics"],
    ["Chief Data Officer", "CDO"],
  ],
  sales: [
    ["Sales Manager", "Regional Sales Manager", "Sales Lead"],
    ["Director of Sales", "Sales Director", "Regional Sales Director"],
    ["VP of Sales", "VP Sales", "Head of Sales"],
    ["CRO", "Chief Revenue Officer", "Chief Sales Officer"],
  ],
  marketing: [
    ["Marketing Manager", "Demand Generation Manager", "Brand Manager"],
    ["Director of Marketing", "Marketing Director", "Director of Demand Generation"],
    ["VP of Marketing", "VP Marketing", "Head of Marketing", "Head of Growth"],
    ["CMO", "Chief Marketing Officer"],
  ],
  finance: [
    ["Finance Manager", "Accounting Manager", "Controller"],
    ["Director of Finance", "Finance Director", "Assistant Controller"],
    ["VP of Finance", "Head of Finance", "VP Finance"],
    ["CFO", "Chief Financial Officer"],
  ],
  operations: [
    ["Operations Manager", "Business Operations Manager", "Ops Manager"],
    ["Director of Operations", "Operations Director", "Director of Business Operations"],
    ["VP of Operations", "Head of Operations", "Head of Ops"],
    ["COO", "Chief Operating Officer"],
  ],
  people_hr: [
    ["HR Manager", "Talent Acquisition Manager", "Recruiting Manager", "People Operations Manager"],
    ["Director of People", "Director of HR", "Director of Talent", "HR Director"],
    ["VP of People", "Head of People", "Head of Talent", "VP of HR"],
    ["CHRO", "Chief People Officer", "Chief Human Resources Officer"],
  ],
  customer_success: [
    ["Customer Success Manager", "CS Manager", "Director of Account Management"],
    ["Director of Customer Success", "CS Director"],
    ["VP of Customer Success", "Head of Customer Success"],
    ["Chief Customer Officer", "Chief Customer Success Officer"],
  ],
  legal: [
    ["Legal Manager", "Corporate Counsel", "Associate General Counsel"],
    ["Director of Legal", "Senior Counsel", "Legal Director"],
    ["Head of Legal", "General Counsel", "VP of Legal"],
    ["Chief Legal Officer", "General Counsel"],
  ],
  executive: [
    ["Chief of Staff", "General Manager"],
    ["Vice President", "General Manager"],
    ["President", "Managing Director"],
    ["CEO", "Founder", "Co-Founder"],
  ],
  other: [
    ["Manager"],
    ["Director", "Senior Manager"],
    ["VP", "Head of", "Vice President"],
    ["President", "CEO", "Founder"],
  ],
};

/** The founder/owner tail — appended for flat, founder-led companies where the top signs off and
 *  is the most findable person on the team page. */
const FOUNDER_TAIL = ["Founder", "Co-Founder", "CEO", "Owner", "President"];

/** Rung index → the seniority band that rung represents (for the floor + scorer). */
const RUNG_SENIORITY: Seniority[] = ["manager", "director", "vp", "c_level"];

/* ------------------------------------------------------------------ */
/* Rung selection: role seniority × company size                       */
/* ------------------------------------------------------------------ */

/** The rung that owns a role of the given seniority in a DEEP (enterprise) org — the baseline,
 *  before the company-size compression shifts it up for flatter orgs. */
function baseRungForRole(seniority: Seniority): number {
  const r = seniorityRank(seniority);
  if (r <= seniorityRank("senior")) return 0;       // IC → first-line manager
  if (r === seniorityRank("lead")) return 1;        // lead/staff IC → director
  if (r === seniorityRank("manager")) return 1;     // a manager req is owned by a director
  if (r === seniorityRank("director")) return 2;    // a director req → VP
  return 3;                                          // vp / c_level / founder req → C-level / founder
}

/**
 * How many rungs FLATTER the org is than an enterprise (so we shift the owner UP). Smaller company
 * = fewer layers = the head/exec owns hiring directly. Unknown size assumes SMB (+1) since the
 * curated pool is the 100-5,000 band and findability favors targeting up.
 */
function orgCompression(size?: number): { shift: number; stage: string } {
  if (typeof size !== "number" || !isFinite(size) || size <= 0) return { shift: 1, stage: "mid-market" };
  if (size <= 250) return { shift: 2, stage: "flat / founder-led" };
  if (size <= 600) return { shift: 1, stage: "small" };
  if (size <= 2000) return { shift: 1, stage: "mid-market" };
  return { shift: 0, stage: "enterprise" };
}

/* ------------------------------------------------------------------ */
/* The target                                                          */
/* ------------------------------------------------------------------ */

export interface HiringManagerTarget {
  /** The role this target was derived from. */
  roleTitle: string;
  roleIntel: TitleIntel;
  roleFunction: JobFunction;
  roleSeniority: Seniority;
  /** Titles to search for, best-first (the hire's OWNER leads, then up the chain of command). */
  candidateTitles: string[];
  /** Lowest acceptable owner seniority (size-aware: higher floor at flatter companies). */
  seniorityFloor: Seniority;
  /** The role is itself leadership → the hiring manager is an exec/founder. */
  execHire: boolean;
  /** Which rung (0 mgr … 3 C-level) we resolved as the owner, + the company stage we inferred. */
  ownerRung: number;
  companyStage: string;
  /** One-line explanation for the UI / logs. */
  rationale: string;
}

/**
 * Derive the hiring-manager target profile from a posted role title and (optionally) the company's
 * headcount. Size is what makes this correct: the same role is owned by a line Manager at a 3,000-
 * person company and by the VP/founder at a 150-person one.
 */
export function hiringManagerTarget(
  roleTitle: string,
  opts?: { companySize?: number },
): HiringManagerTarget {
  const intel = classifyTitle(roleTitle);
  const fn = intel.function;
  const ladder = LADDER[fn] ?? LADDER.other;

  // Owner rung = where the role sits in a deep org, shifted UP by how flat this company is.
  const base = baseRungForRole(intel.seniority);
  const { shift, stage } = orgCompression(opts?.companySize);
  const ownerRung = Math.min(3, base + shift);

  // Candidate titles: the owner rung first, then up the chain of command (2 titles/rung keeps the
  // findable seniors inside the first few — which is what the search queries use). Founder tail for
  // flat companies, where the top owns hiring and is the most findable face on the site.
  const titles: string[] = [];
  for (let r = ownerRung; r <= 3; r++) {
    for (const t of ladder[r].slice(0, 2)) if (!titles.includes(t)) titles.push(t);
  }
  if (stage === "flat / founder-led" || ownerRung >= 3) {
    for (const t of FOUNDER_TAIL) if (!titles.includes(t)) titles.push(t);
  }

  // Floor: allow one rung below the owner as a lower bound (the direct manager), never below the
  // owner rung at flat companies where no such layer exists.
  const floorRung = Math.max(0, ownerRung - 1);
  const seniorityFloor = RUNG_SENIORITY[floorRung];

  const execHire = base >= 2; // a director+ req is itself a leadership hire owned by an exec
  const ownerLabel = titles[0] ?? RUNG_SENIORITY[ownerRung];
  const rationale = execHire
    ? `"${roleTitle}" is a ${intel.seniority}-level ${fn} leadership hire at a ${stage} company — owned by the ${fn} exec (${ownerLabel}) or a founder.`
    : `"${roleTitle}" is ${intel.seniority}-level ${fn} at a ${stage} company; at this org depth the hire is owned by the ${ownerLabel} (and up the chain), not a first-line manager.`;

  return {
    roleTitle,
    roleIntel: intel,
    roleFunction: fn,
    roleSeniority: intel.seniority,
    candidateTitles: titles.length ? titles : LADDER.other[2],
    seniorityFloor,
    execHire,
    ownerRung,
    companyStage: stage,
    rationale,
  };
}
