/**
 * RecruiterOS · Hiring Engine
 * Target-profile inference — turn a posted role into "who manages it."
 *
 * Indeed almost never names the hiring manager. But the manager over a role is, with high
 * reliability, ONE LEVEL UP in the SAME FUNCTION. So from a role title we derive the
 * profile of the person to go find: their function, the titles they'd hold, and the
 * seniority band that counts as "the decision-maker for this req."
 *
 *   "Backend Engineer"  → eng IC      → search {Eng Manager, Director Eng, VP Eng}
 *   "Staff Designer"    → senior IC   → search {Head of Design, Director Design}
 *   "VP of Engineering" → exec hire   → search {CTO, CEO}  (the role IS leadership)
 *
 * Reuses classifyTitle() from ../filters so "VP of Eng", "Head of Engineering", and
 * "Engineering Director" all resolve the same way. Pure + deterministic.
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

/** The manager of an IC sits one rung up, but never below "manager". */
function managerFloorFor(roleSeniority: Seniority): Seniority {
  const r = seniorityRank(roleSeniority);
  // IC bands (intern..senior) → floor at manager. Lead/principal → floor at director.
  if (r <= seniorityRank("senior")) return "manager";
  if (r === seniorityRank("lead")) return "director";
  if (r === seniorityRank("manager")) return "director";
  if (r === seniorityRank("director")) return "vp";
  return "c_level"; // vp / c_level / founder roles → hired by the top
}

/* ------------------------------------------------------------------ */
/* Per-function leadership titles (best-first, "one level up" leads)   */
/* ------------------------------------------------------------------ */

/**
 * The titles a hiring manager over a role in each function typically holds, ordered so the
 * closest manager ("Engineering Manager") leads and the exec ("CTO") trails. The resolver
 * searches these and scores a candidate higher the earlier its title matches.
 */
const LEADERSHIP_TITLES: Record<JobFunction, string[]> = {
  engineering: [
    "Engineering Manager", "Software Engineering Manager", "Director of Engineering",
    "Head of Engineering", "VP of Engineering", "VP Engineering", "CTO", "VP of Technology",
  ],
  product: [
    "Group Product Manager", "Director of Product", "Head of Product",
    "VP of Product", "VP Product", "CPO", "Chief Product Officer",
  ],
  design: [
    "Design Manager", "Design Lead", "Director of Design", "Head of Design",
    "VP of Design", "Creative Director", "Chief Design Officer",
  ],
  data: [
    "Data Science Manager", "Analytics Manager", "Director of Data",
    "Head of Data", "VP of Data", "Chief Data Officer", "Head of Analytics",
  ],
  sales: [
    "Sales Manager", "Sales Director", "Director of Sales", "Head of Sales",
    "VP of Sales", "VP Sales", "Chief Revenue Officer", "CRO", "Head of Revenue",
  ],
  marketing: [
    "Marketing Manager", "Director of Marketing", "Head of Marketing",
    "VP of Marketing", "VP Marketing", "CMO", "Head of Growth", "Growth Lead",
  ],
  finance: [
    "Finance Manager", "Controller", "Director of Finance", "Head of Finance",
    "VP of Finance", "CFO", "VP Finance",
  ],
  operations: [
    "Operations Manager", "Director of Operations", "Head of Operations",
    "VP of Operations", "COO", "Chief Operating Officer", "Head of Ops",
  ],
  people_hr: [
    "HR Manager", "Talent Acquisition Manager", "Recruiting Manager",
    "Director of People", "Head of People", "Head of Talent", "VP of People", "CHRO",
  ],
  customer_success: [
    "Customer Success Manager", "CS Manager", "Director of Customer Success",
    "Head of Customer Success", "VP of Customer Success", "Chief Customer Officer",
  ],
  legal: [
    "Legal Manager", "Associate General Counsel", "Director of Legal",
    "Head of Legal", "General Counsel", "Chief Legal Officer", "VP of Legal",
  ],
  executive: [
    "CEO", "Founder", "Co-Founder", "President", "Chief of Staff", "COO",
  ],
  other: [
    "Manager", "Director", "Head of", "VP", "Founder", "CEO",
  ],
};

/** The exec a leadership-level role reports into, by function (for the execHire case). */
const EXEC_FOR_FUNCTION: Record<JobFunction, string[]> = {
  engineering: ["CTO", "VP of Engineering", "CEO", "Founder"],
  product: ["CPO", "Chief Product Officer", "CEO", "Founder"],
  design: ["Chief Design Officer", "VP of Design", "CEO", "Founder"],
  data: ["Chief Data Officer", "CTO", "CEO"],
  sales: ["CRO", "Chief Revenue Officer", "CEO", "Founder"],
  marketing: ["CMO", "CEO", "Founder"],
  finance: ["CFO", "CEO"],
  operations: ["COO", "CEO", "Founder"],
  people_hr: ["CHRO", "Chief People Officer", "CEO", "Founder"],
  customer_success: ["Chief Customer Officer", "COO", "CEO"],
  legal: ["Chief Legal Officer", "General Counsel", "CEO"],
  executive: ["CEO", "Founder", "Co-Founder", "Board"],
  other: ["CEO", "Founder"],
};

/* ------------------------------------------------------------------ */
/* The target                                                          */
/* ------------------------------------------------------------------ */

export interface HiringManagerTarget {
  /** The role this target was derived from. */
  roleTitle: string;
  roleIntel: TitleIntel;
  roleFunction: JobFunction;
  roleSeniority: Seniority;
  /** Titles to search for, best-first (closest manager leads). */
  candidateTitles: string[];
  /** Lowest acceptable manager seniority (e.g. "manager" for an IC role). */
  seniorityFloor: Seniority;
  /** The role is itself leadership → the hiring manager is an exec/founder. */
  execHire: boolean;
  /** One-line explanation for the UI / logs. */
  rationale: string;
}

/**
 * Derive the hiring-manager target profile from a posted role title.
 */
export function hiringManagerTarget(roleTitle: string): HiringManagerTarget {
  const intel = classifyTitle(roleTitle);
  const fn = intel.function;
  const floor = managerFloorFor(intel.seniority);
  const execHire = seniorityRank(intel.seniority) >= seniorityRank("director");

  const titles = execHire
    ? EXEC_FOR_FUNCTION[fn]
    : LEADERSHIP_TITLES[fn].filter((t) => {
        // For an IC role, keep the full ladder. For a manager-level role, drop the
        // first-line-manager titles and lead with director+.
        if (intel.seniority === "manager") return !/manager$/i.test(t);
        return true;
      });

  const rationale = execHire
    ? `"${roleTitle}" is a leadership role; the hiring manager is the ${fn} exec or a founder.`
    : `"${roleTitle}" is ${intel.seniority}-level ${fn}; the hiring manager is one level up — ${titles[0]} or above.`;

  return {
    roleTitle,
    roleIntel: intel,
    roleFunction: fn,
    roleSeniority: intel.seniority,
    candidateTitles: titles.length ? titles : LEADERSHIP_TITLES.other,
    seniorityFloor: floor,
    execHire,
    rationale,
  };
}
