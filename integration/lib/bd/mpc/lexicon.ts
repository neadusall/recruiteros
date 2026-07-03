/**
 * RecruitersOS · BD · MPC · Industry lexicon
 *
 * The difference between "a recruiter" and "a recruiter who works MY space" is vocabulary. A hiring
 * manager clocks it in two seconds. This bank gives the MPC engine the native tongue of each vertical:
 *
 *  - roleAbbrev   — how insiders shorten the title ("Account Executive" -> "AE", "Registered Nurse"
 *                   -> "RN", "Software Engineer" -> "engineer"/"IC"). Used to render {Open_Role} /
 *                   {Job_Title} the way a peer would say it, not the way a job board prints it.
 *  - proofBank    — native "must-have" proof CLAUSES (2-5 words, never single keywords) used to fill
 *                   {MH1}/{MH2} when the JD extraction is thin or absent, so the email still reads
 *                   like an insider with ZERO AI cost.
 *  - metricBank   — native ways insiders state a quantified win, for {Metric}.
 *  - jdStyle      — a short directive handed to the JD extractor so the must-haves it pulls from the
 *                   real posting come back in native phrasing (this is the AI hook; the bank is the
 *                   deterministic floor under it).
 *
 * IMPORTANT: none of this vocabulary is hardcoded in the 50 templates — it ALL arrives through the
 * resolved tokens. That's what lets one template set speak sales, nursing, or engineering natively.
 * Function keys mirror lib/signals `JobFunction`; unknown roles fall back to `generic`.
 */

export interface Lexicon {
  /** Insider short forms, longest-key-first match against the title. */
  roleAbbrev: Array<[RegExp, string]>;
  /** Native proof clauses (fallback / deterministic floor for {MH1}/{MH2}). */
  proofBank: string[];
  /** Native quantified-win phrasings for {Metric}. */
  metricBank: string[];
  /** Directive for the LLM JD extractor so pulled must-haves sound native. */
  jdStyle: string;
}

const SALES: Lexicon = {
  roleAbbrev: [
    [/account executive|\bae\b/i, "AE"],
    [/sales development|\bsdr\b|\bbdr\b/i, "SDR"],
    [/account manager|\bam\b/i, "AM"],
    [/customer success|\bcsm\b/i, "CSM"],
    [/sales engineer|\bse\b/i, "sales engineer"],
    [/regional sales manager|sales manager/i, "sales manager"],
    [/vp of sales|vp sales|head of sales/i, "sales leader"],
  ],
  proofBank: [
    "closed six-figure ARR deals", "full-cycle closer", "net-new logos",
    "built the territory from zero", "consistent quota attainment", "President's Club last year",
    "greenfield territory", "strong in mid-market", "moves up-market cleanly",
  ],
  metricBank: ["142% to quota", "top rep on the team", "$2M+ number", "3 years over plan"],
  jdStyle: "Sales roles: pull proof as short outcome clauses in rep language (quota %, ARR/deal size, net-new logos, segment, cycle ownership). Never list tools as a must-have.",
};

const NURSING: Lexicon = {
  roleAbbrev: [
    [/registered nurse|\brn\b/i, "RN"],
    [/nurse practitioner|\bnp\b/i, "NP"],
    [/licensed practical nurse|\blpn\b/i, "LPN"],
    [/certified nursing assistant|\bcna\b/i, "CNA"],
    [/charge nurse/i, "charge nurse"],
  ],
  proofBank: [
    "3 years med-surg", "ICU-trained", "charge experience", "BSN, ACLS certified",
    "level-1 trauma background", "strong on high-acuity floors", "float-pool flexible",
  ],
  metricBank: ["12 years bedside", "precepts new grads", "top of a 40-bed unit"],
  jdStyle: "Nursing roles: pull proof as unit/acuity + certs + years (e.g. 'ICU-trained, ACLS, 3 years med-surg'). Use RN/BSN/CNA/NP correctly.",
};

const ENGINEERING: Lexicon = {
  roleAbbrev: [
    [/staff engineer|staff software/i, "Staff Engineer"],
    [/senior software|senior engineer|\bsr\.? eng/i, "senior engineer"],
    [/software engineer|developer|\bswe\b/i, "engineer"],
    [/engineering manager|\bem\b/i, "eng manager"],
    [/site reliability|\bsre\b|devops/i, "SRE"],
    [/individual contributor|\bic\b/i, "IC"],
  ],
  proofBank: [
    "deep in distributed systems", "scaled services at high traffic", "strong systems design",
    "on-call lead", "mentors the juniors", "ships product end to end", "polyglot, pragmatic",
  ],
  metricBank: ["8 years shipping", "led a platform rewrite", "cut latency in half"],
  jdStyle: "Engineering roles: pull proof as systems/scope clauses (distributed systems, scale, on-call, mentorship, product ownership), not a language checklist.",
};

const FINANCE: Lexicon = {
  roleAbbrev: [
    [/financial planning|\bfp&a\b|fp and a/i, "FP&A"],
    [/controller/i, "controller"],
    [/chief financial|\bcfo\b/i, "CFO"],
    [/accountant|accounting/i, "accountant"],
    [/financial analyst/i, "analyst"],
  ],
  proofBank: [
    "owns the monthly close", "built the board deck", "GAAP-clean", "SaaS metrics fluent",
    "ran a Series B raise", "3-statement modeler", "audit-ready books",
  ],
  metricBank: ["closes in 5 days", "scaled through a raise", "10 years in the seat"],
  jdStyle: "Finance roles: pull proof as ownership clauses (close, FP&A, GAAP, modeling, fundraise), not software names.",
};

const MARKETING: Lexicon = {
  roleAbbrev: [
    [/demand generation|demand gen/i, "demand gen"],
    [/growth marketing|\bgrowth\b/i, "growth"],
    [/product marketing|\bpmm\b/i, "PMM"],
    [/content marketing|\bcontent\b/i, "content"],
    [/chief marketing|\bcmo\b|vp marketing|head of marketing/i, "marketing leader"],
  ],
  proofBank: [
    "owns pipeline number", "scaled paid from scratch", "strong on positioning",
    "ran ABM that worked", "content that converts", "lifecycle + demand both",
  ],
  metricBank: ["3x'd inbound", "drove 40% of pipeline", "cut CAC meaningfully"],
  jdStyle: "Marketing roles: pull proof as outcome clauses (pipeline, CAC, channel scale, positioning), tied to revenue where possible.",
};

const GENERIC: Lexicon = {
  roleAbbrev: [],
  proofBank: [
    "strong track record", "did exactly this at their last shop", "hits the ground running",
    "well-referenced", "the kind you build around",
  ],
  metricBank: ["top of their team", "years of the right experience", "proven in the seat"],
  jdStyle: "Pull 2 must-haves from the posting as short outcome clauses (2-5 words each), in the language of that profession. Never list tools/keywords.",
};

const BY_FUNCTION: Record<string, Lexicon> = {
  sales: SALES,
  revenue: SALES,
  nursing: NURSING,
  healthcare: NURSING,
  clinical: NURSING,
  engineering: ENGINEERING,
  software: ENGINEERING,
  product: ENGINEERING,
  finance: FINANCE,
  accounting: FINANCE,
  marketing: MARKETING,
};

/** Get the lexicon for a function key (from classifyTitle), falling back to generic. */
export function lexiconFor(func: string | undefined): Lexicon {
  return BY_FUNCTION[String(func || "").toLowerCase()] ?? GENERIC;
}

/** Render a job title the way an insider says it ("Senior Account Executive" -> "Senior AE" when the
 *  short form applies mid-title, else the AE token; unknown roles return the title unchanged). */
export function nativeRole(title: string | undefined, func: string | undefined): string {
  const t = String(title || "").trim();
  if (!t) return "";
  const lex = lexiconFor(func);
  for (const [re, short] of lex.roleAbbrev) {
    if (re.test(t)) {
      // Preserve a leading seniority word ("Senior", "Sr", "Lead") in front of the short form.
      const sr = t.match(/^(senior|sr\.?|lead|staff|principal|head of|vp)\b/i);
      return sr && !/^(staff|head of|vp)/i.test(short) ? `${titleWord(sr[1])} ${short}` : short;
    }
  }
  return t;
}

function titleWord(s: string): string {
  const w = s.toLowerCase().replace(/\.$/, "");
  if (w === "sr") return "Senior";
  return w.charAt(0).toUpperCase() + w.slice(1);
}
