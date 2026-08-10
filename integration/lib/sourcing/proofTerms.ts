/**
 * RecruitersOS · JD Sourcing — PROOF TERMS: the long-tail vocabulary that separates
 * "has the title" from "can actually do the job".
 *
 * WHY THIS EXISTS. Discovery has always searched on TITLE plus GEO, which is the
 * coarsest possible filter. `site:linkedin.com/in ("Senior Accountant") "New Jersey"`
 * returns everyone in a 25-mile radius who ever held the words, and a recruiter (or a
 * paid deep-vet) then pays to find out that most of them are the wrong depth, wrong
 * specialty, or wrong industry. The qualifying evidence was sitting in the profile the
 * whole time and nothing looked at it.
 *
 * The verticals this desk actually staffs are unusually rich in HARD evidence, far more
 * so than the software roles the market's AI sourcing tools are tuned for. An accountant
 * who has done tax provisions writes "ASC 740" in their headline. A behavior analyst
 * writes "BCBA". A nursing-home controller writes "SNF" or "PointClickCare". These terms
 * are self-selecting: nobody puts "ASC 740" on a profile without having touched it.
 *
 * So a proof term does double duty, and that is the whole idea:
 *   1) IN THE QUERY — it narrows the X-ray itself, so the engine returns a smaller,
 *      better list instead of us filtering a big bad one after paying for it.
 *   2) IN THE SCORE — evidence found in a title, headline or snippet is a reason to
 *      rank someone up, and a reason we can SHOW the recruiter in plain English.
 *
 * Economically this only became sensible once discovery had a cheap engine: a proof
 * matrix multiplies query count (titles x proof groups), and at the old per-search
 * prices that was the expensive direction. See lib/sourcing/discovery.ts.
 *
 * PURE MODULE, no I/O and no LLM: the library below is the floor of domain knowledge
 * that applies to every run in these verticals, and the per-JD extractor adds whatever
 * a specific role needs on top. Tested by scripts/test-sourcing-prooofterms.mts.
 */

/** What kind of evidence a term is. Kinds score differently: a licence is worth more
 *  than a tool, because a licence is gate-keeping and a tool is exposure. */
export type ProofKind = "credential" | "system" | "domain" | "scope";

export interface ProofTerm {
  /** Canonical form, and what we show the recruiter. */
  term: string;
  /** Other ways the same thing is written on a profile. Matched case-insensitively.
   *  Keep these tight: a loose alias turns a precision signal into noise. */
  aliases?: string[];
  kind: ProofKind;
  /** Relative strength, 1..3. 3 = gate-keeping (a licence you either hold or do not),
   *  2 = strong specialty evidence, 1 = supporting colour. */
  weight: 1 | 2 | 3;
  /** Terms that should never be matched by a bare substring because the short form
   *  collides with ordinary words ("EA", "PA", "OT"). Requires a word-boundary hit
   *  AND upper-case in the source text. */
  strict?: boolean;
}

/** Vertical keys. A run can carry more than one (a nursing-home controller is both
 *  accounting and healthcare, and the overlap is exactly where the good candidates are). */
export type ProofVertical =
  | "accounting_tax"
  | "finance_leadership"
  | "behavioral_health"
  | "healthcare_ops"
  | "operations";

/* ------------------------------------------------------------------ */
/* The library                                                         */
/* ------------------------------------------------------------------ */

const ACCOUNTING_TAX: ProofTerm[] = [
  // Credentials: the strongest filter in this vertical. A CPA line in a headline is
  // the single most reliable predictor that a resume will survive a client screen.
  { term: "CPA", aliases: ["Certified Public Accountant"], kind: "credential", weight: 3 },
  { term: "EA", aliases: ["Enrolled Agent"], kind: "credential", weight: 3, strict: true },
  { term: "CMA", aliases: ["Certified Management Accountant"], kind: "credential", weight: 2 },
  { term: "CIA", aliases: ["Certified Internal Auditor"], kind: "credential", weight: 2, strict: true },
  { term: "CFE", aliases: ["Certified Fraud Examiner"], kind: "credential", weight: 2, strict: true },
  { term: "MST", aliases: ["Master of Science in Taxation", "Masters in Taxation"], kind: "credential", weight: 2, strict: true },

  // Domain phrases: what they actually did. These are the long tail that title search
  // cannot reach, and they are how a tax person proves depth rather than exposure.
  { term: "ASC 740", aliases: ["FAS 109", "income tax provision", "tax provision"], kind: "domain", weight: 3 },
  { term: "ASC 606", aliases: ["revenue recognition", "rev rec"], kind: "domain", weight: 2 },
  { term: "ASC 842", aliases: ["lease accounting"], kind: "domain", weight: 2 },
  { term: "transfer pricing", kind: "domain", weight: 3 },
  { term: "SALT", aliases: ["state and local tax"], kind: "domain", weight: 2, strict: true },
  { term: "international tax", kind: "domain", weight: 2 },
  { term: "R&D credit", aliases: ["research and development credit", "R&D tax credit"], kind: "domain", weight: 2 },
  { term: "1120", aliases: ["Form 1120", "1120S"], kind: "domain", weight: 2 },
  { term: "1065", aliases: ["Form 1065", "partnership return"], kind: "domain", weight: 2 },
  { term: "K-1", aliases: ["Schedule K-1"], kind: "domain", weight: 2 },
  { term: "month-end close", aliases: ["month end close", "monthly close", "close process"], kind: "domain", weight: 1 },
  { term: "consolidations", aliases: ["consolidation", "multi-entity"], kind: "domain", weight: 2 },
  { term: "technical accounting", kind: "domain", weight: 2 },
  { term: "SEC reporting", aliases: ["10-K", "10-Q", "SEC filings"], kind: "domain", weight: 3 },
  { term: "SOX", aliases: ["Sarbanes-Oxley", "internal controls"], kind: "domain", weight: 2, strict: true },
  { term: "GAAP", aliases: ["US GAAP"], kind: "domain", weight: 1 },
  { term: "IFRS", kind: "domain", weight: 1 },

  // Systems: exposure evidence, and a good tiebreaker when a client runs that stack.
  { term: "NetSuite", kind: "system", weight: 2 },
  { term: "Sage Intacct", aliases: ["Intacct"], kind: "system", weight: 2 },
  { term: "Yardi", kind: "system", weight: 2 },
  { term: "MRI Software", aliases: ["MRI real estate"], kind: "system", weight: 2 },
  { term: "Workday", kind: "system", weight: 1 },
  { term: "SAP", kind: "system", weight: 1, strict: true },
  { term: "Oracle", kind: "system", weight: 1 },
  { term: "QuickBooks", aliases: ["QBO"], kind: "system", weight: 1 },
  { term: "CCH Axcess", aliases: ["ProSystem fx", "CCH"], kind: "system", weight: 2 },
  { term: "GoSystem", aliases: ["GoSystem Tax"], kind: "system", weight: 2 },
  { term: "OneSource", aliases: ["Thomson Reuters OneSource"], kind: "system", weight: 2 },
  { term: "UltraTax", kind: "system", weight: 2 },
  { term: "Lacerte", kind: "system", weight: 1 },

  // Scope: the shape of the seat, which is often what a client is really buying.
  { term: "public accounting", aliases: ["public practice"], kind: "scope", weight: 2 },
  { term: "Big 4", aliases: ["Big Four", "Deloitte", "PwC", "KPMG", "Ernst & Young", "EY"], kind: "scope", weight: 2 },
  { term: "family office", kind: "scope", weight: 3 },
  { term: "high net worth", aliases: ["HNW", "ultra high net worth", "UHNW"], kind: "scope", weight: 2 },
  { term: "private equity", aliases: ["PE-backed", "portfolio company"], kind: "scope", weight: 2 },
  { term: "real estate", aliases: ["property accounting", "REIT"], kind: "scope", weight: 1 },
];

const FINANCE_LEADERSHIP: ProofTerm[] = [
  { term: "FP&A", aliases: ["financial planning and analysis"], kind: "domain", weight: 3 },
  { term: "budgeting and forecasting", aliases: ["budget and forecast", "forecasting"], kind: "domain", weight: 2 },
  { term: "variance analysis", kind: "domain", weight: 2 },
  { term: "cash flow forecasting", aliases: ["cash management", "treasury"], kind: "domain", weight: 2 },
  { term: "three-statement model", aliases: ["financial modeling", "financial model"], kind: "domain", weight: 2 },
  { term: "board reporting", aliases: ["board deck", "board presentations"], kind: "domain", weight: 2 },
  { term: "due diligence", aliases: ["M&A", "buy-side", "sell-side"], kind: "domain", weight: 2 },
  { term: "P&L ownership", aliases: ["P&L responsibility", "owned the P&L"], kind: "scope", weight: 3 },
  { term: "Adaptive Insights", aliases: ["Adaptive Planning", "Anaplan", "Vena", "Planful"], kind: "system", weight: 2 },
  { term: "Power BI", aliases: ["Tableau", "Looker"], kind: "system", weight: 1 },
];

const BEHAVIORAL_HEALTH: ProofTerm[] = [
  // The cleanest vertical in the whole book: the licence IS the qualification, it is
  // public record, and candidates put it in their headline without being asked.
  { term: "BCBA", aliases: ["Board Certified Behavior Analyst"], kind: "credential", weight: 3 },
  { term: "BCBA-D", aliases: ["Doctoral Board Certified Behavior Analyst"], kind: "credential", weight: 3 },
  { term: "BCaBA", aliases: ["Board Certified Assistant Behavior Analyst"], kind: "credential", weight: 2 },
  { term: "RBT", aliases: ["Registered Behavior Technician"], kind: "credential", weight: 2 },
  { term: "LBA", aliases: ["Licensed Behavior Analyst"], kind: "credential", weight: 3, strict: true },
  { term: "LCSW", aliases: ["Licensed Clinical Social Worker"], kind: "credential", weight: 3 },
  { term: "LMFT", aliases: ["Licensed Marriage and Family Therapist"], kind: "credential", weight: 3 },
  { term: "LMHC", aliases: ["LPC", "Licensed Professional Counselor", "Licensed Mental Health Counselor"], kind: "credential", weight: 3 },

  { term: "applied behavior analysis", aliases: ["ABA therapy", "ABA"], kind: "domain", weight: 3 },
  { term: "autism", aliases: ["ASD", "autism spectrum"], kind: "domain", weight: 2 },
  { term: "early intervention", aliases: ["EI services"], kind: "domain", weight: 2 },
  { term: "verbal behavior", aliases: ["VB-MAPP", "ABLLS"], kind: "domain", weight: 2 },
  { term: "functional behavior assessment", aliases: ["FBA", "behavior intervention plan", "BIP"], kind: "domain", weight: 2 },
  { term: "IEP", aliases: ["individualized education program"], kind: "domain", weight: 1, strict: true },
  { term: "parent training", kind: "domain", weight: 1 },

  { term: "CentralReach", kind: "system", weight: 2 },
  { term: "Rethink", aliases: ["RethinkBH"], kind: "system", weight: 2 },
  { term: "Therap", kind: "system", weight: 1 },

  { term: "clinical supervision", aliases: ["supervised RBTs", "supervising BCBAs"], kind: "scope", weight: 2 },
  { term: "multi-site", aliases: ["multisite", "multiple clinics", "regional"], kind: "scope", weight: 2 },
  { term: "caseload", kind: "scope", weight: 1 },
];

const HEALTHCARE_OPS: ProofTerm[] = [
  { term: "LNHA", aliases: ["Licensed Nursing Home Administrator", "NHA"], kind: "credential", weight: 3 },
  { term: "RN", aliases: ["Registered Nurse"], kind: "credential", weight: 2, strict: true },
  { term: "MSN", aliases: ["Master of Science in Nursing"], kind: "credential", weight: 2, strict: true },

  { term: "skilled nursing", aliases: ["SNF", "skilled nursing facility"], kind: "domain", weight: 3 },
  { term: "long-term care", aliases: ["LTC", "long term care"], kind: "domain", weight: 3 },
  { term: "assisted living", aliases: ["ALF", "senior living"], kind: "domain", weight: 2 },
  { term: "home health", aliases: ["home care", "hospice"], kind: "domain", weight: 2 },
  { term: "PDPM", aliases: ["Patient Driven Payment Model"], kind: "domain", weight: 3 },
  { term: "MDS", aliases: ["Minimum Data Set", "MDS coordinator"], kind: "domain", weight: 3, strict: true },
  { term: "census", aliases: ["census growth", "occupancy"], kind: "domain", weight: 2 },
  { term: "survey readiness", aliases: ["state survey", "CMS survey", "deficiency-free"], kind: "domain", weight: 2 },
  { term: "Medicare and Medicaid", aliases: ["Medicare", "Medicaid", "CMS"], kind: "domain", weight: 1 },
  { term: "revenue cycle", aliases: ["RCM", "revenue cycle management"], kind: "domain", weight: 2 },
  { term: "utilization review", aliases: ["UR", "utilization management"], kind: "domain", weight: 2 },
  { term: "value-based care", aliases: ["VBC", "population health"], kind: "domain", weight: 2 },
  { term: "Joint Commission", aliases: ["JCAHO", "accreditation"], kind: "domain", weight: 2 },

  { term: "PointClickCare", aliases: ["PCC"], kind: "system", weight: 3 },
  { term: "MatrixCare", kind: "system", weight: 3 },
  { term: "Epic", aliases: ["Epic Systems"], kind: "system", weight: 2, strict: true },
  { term: "Cerner", kind: "system", weight: 2 },
  { term: "WellSky", kind: "system", weight: 2 },
  { term: "Meditech", kind: "system", weight: 1 },
];

const OPERATIONS: ProofTerm[] = [
  { term: "PMP", aliases: ["Project Management Professional"], kind: "credential", weight: 2, strict: true },
  { term: "Six Sigma", aliases: ["Lean Six Sigma", "Black Belt", "Green Belt"], kind: "credential", weight: 2 },
  { term: "CPIM", aliases: ["CSCP", "APICS"], kind: "credential", weight: 2, strict: true },

  { term: "continuous improvement", aliases: ["Kaizen", "5S", "lean manufacturing"], kind: "domain", weight: 2 },
  { term: "S&OP", aliases: ["sales and operations planning"], kind: "domain", weight: 2 },
  { term: "P&L", aliases: ["profit and loss"], kind: "scope", weight: 2, strict: true },
  { term: "multi-site", aliases: ["multisite", "multiple locations", "regional operations"], kind: "scope", weight: 2 },
  { term: "plant operations", aliases: ["plant manager", "manufacturing operations"], kind: "scope", weight: 2 },
  { term: "distribution", aliases: ["fulfillment", "warehouse operations", "3PL"], kind: "scope", weight: 1 },
  { term: "ERP implementation", aliases: ["ERP rollout", "system implementation"], kind: "domain", weight: 2 },
];

export const PROOF_LIBRARY: Record<ProofVertical, ProofTerm[]> = {
  accounting_tax: ACCOUNTING_TAX,
  finance_leadership: FINANCE_LEADERSHIP,
  behavioral_health: BEHAVIORAL_HEALTH,
  healthcare_ops: HEALTHCARE_OPS,
  operations: OPERATIONS,
};

/** Plain-English vertical names, for anything a recruiter reads. */
export const VERTICAL_LABEL: Record<ProofVertical, string> = {
  accounting_tax: "Accounting and tax",
  finance_leadership: "Finance leadership",
  behavioral_health: "Behavioral health",
  healthcare_ops: "Healthcare operations",
  operations: "Operations",
};

/* ------------------------------------------------------------------ */
/* Vertical detection                                                  */
/* ------------------------------------------------------------------ */

/** Cheap signals that say which shelf of the library a job description belongs on.
 *  Deliberately keyword-based, not an LLM call: this runs before the parse and its
 *  only job is to pick which vocabulary to offer, so a wrong guess costs a slightly
 *  wider term list rather than a wrong search. */
const VERTICAL_HINTS: Record<ProofVertical, string[]> = {
  accounting_tax: ["accountant", "accounting", "tax", "audit", "controller", "bookkeep", "cpa", "provision"],
  finance_leadership: ["cfo", "vp finance", "finance director", "fp&a", "financial planning", "treasury", "controller"],
  behavioral_health: ["bcba", "behavior analyst", "aba", "autism", "applied behavior", "clinic director", "rbt", "therapist", "counselor", "social worker"],
  healthcare_ops: ["nursing", "snf", "skilled nursing", "long-term care", "long term care", "assisted living", "healthcare", "clinical", "patient", "hospice", "home health", "medicare", "medicaid"],
  operations: ["operations", "coo", "plant", "manufacturing", "supply chain", "warehouse", "logistics", "distribution"],
};

/**
 * Which verticals a job description touches, strongest first. Returns [] when nothing
 * matches, which is the honest answer for a role outside this desk's book: the caller
 * then relies purely on the per-JD extracted terms.
 */
export function detectVerticals(text: string): ProofVertical[] {
  const hay = (text || "").toLowerCase();
  if (!hay.trim()) return [];
  const scored: Array<{ v: ProofVertical; n: number }> = [];
  for (const [v, hints] of Object.entries(VERTICAL_HINTS) as Array<[ProofVertical, string[]]>) {
    let n = 0;
    for (const h of hints) if (hay.includes(h)) n++;
    if (n > 0) scored.push({ v, n });
  }
  // Two verticals is the useful ceiling: a nursing-home controller is genuinely both,
  // but a third shelf only dilutes the query matrix with terms nobody asked for.
  return scored.sort((a, b) => b.n - a.n).slice(0, 2).map((s) => s.v);
}

/** Every term on the shelves for the given verticals, de-duplicated by canonical term. */
export function termsForVerticals(verticals: ProofVertical[]): ProofTerm[] {
  const seen = new Map<string, ProofTerm>();
  for (const v of verticals) {
    for (const t of PROOF_LIBRARY[v] || []) {
      const k = t.term.toLowerCase();
      const prev = seen.get(k);
      // Same term on two shelves: keep the stronger weighting.
      if (!prev || t.weight > prev.weight) seen.set(k, t);
    }
  }
  return [...seen.values()];
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

export interface ProofHit {
  /** Canonical term that matched. */
  term: string;
  kind: ProofKind;
  weight: 1 | 2 | 3;
  /** The exact surface form found, so a reason line can quote the profile. */
  matched: string;
}

/** Regex-escape. */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does `text` contain this surface form as a standalone term?
 *
 * Word boundaries alone are not enough for the short forms. "EA" appears inside no
 * word once bounded, but it appears as a standalone token in plenty of innocent
 * places, and "PA" (Pennsylvania), "OT", "RN" and friends are worse. For terms flagged
 * `strict` we additionally require the source text to carry it in upper case, which is
 * how a real credential is written and how prose almost never is.
 */
function hasSurface(text: string, surface: string, strict: boolean): boolean {
  if (!surface) return false;
  // Terms carrying regex-ish punctuation (&, +, -) still work: they are escaped, and
  // the boundary is expressed as "not a letter or digit" rather than \b, which does
  // not behave at a punctuation edge ("R&D credit", "P&L", "K-1").
  const body = esc(surface);
  const re = new RegExp(`(^|[^A-Za-z0-9])${body}($|[^A-Za-z0-9])`, strict ? "" : "i");
  return re.test(text);
}

/**
 * Find every library term evidenced in a blob of profile text (title, headline and
 * snippet concatenated). Order is strongest evidence first, so a caller that shows
 * only the top few reasons shows the most convincing ones.
 */
export function matchProofTerms(text: string, terms: ProofTerm[]): ProofHit[] {
  const hay = text || "";
  if (!hay.trim()) return [];
  const hits: ProofHit[] = [];
  for (const t of terms) {
    const surfaces = [t.term, ...(t.aliases || [])];
    for (const s of surfaces) {
      if (hasSurface(hay, s, Boolean(t.strict))) {
        hits.push({ term: t.term, kind: t.kind, weight: t.weight, matched: s });
        break; // one hit per canonical term: aliases are the same evidence, not more of it
      }
    }
  }
  return hits.sort((a, b) => b.weight - a.weight);
}

/* ------------------------------------------------------------------ */
/* Query building                                                      */
/* ------------------------------------------------------------------ */

/**
 * Turn proof terms into OR-groups ready to drop into an X-ray boolean.
 *
 * Grouping rather than one-term-per-query is deliberate. A single query carrying
 * ("CPA" OR "Certified Public Accountant" OR "ASC 740" OR "tax provision") finds
 * anyone with ANY of that evidence in one search, which is the cheap way to raise
 * precision without multiplying spend by the size of the vocabulary. Strongest terms
 * lead so that a run truncated by budget still spent on the best evidence.
 *
 * Each group is a ready boolean fragment: (\"a\" OR \"b\" OR \"c\").
 */
export function proofQueryGroups(terms: ProofTerm[], perGroup = 6, maxGroups = 4): string[] {
  const ranked = [...terms].sort((a, b) => b.weight - a.weight);
  const groups: string[] = [];
  for (let i = 0; i < ranked.length && groups.length < maxGroups; i += perGroup) {
    const slice = ranked.slice(i, i + perGroup);
    // One surface form per term keeps the boolean short enough for every engine;
    // the highest-signal alias is the canonical term itself.
    const parts = slice.map((t) => `"${t.term}"`);
    if (parts.length) groups.push(`(${parts.join(" OR ")})`);
  }
  return groups;
}

/**
 * The score contribution of a candidate's proof evidence, and the plain-English
 * reasons behind it.
 *
 * Capped on purpose. Proof is a strong signal but it must not be able to outrank the
 * fundamentals (right title, right place): a profile stuffed with certifications who
 * is the wrong role in the wrong state is still the wrong person, and an uncapped
 * bonus would float them to the top of the list.
 */
export function proofScore(hits: ProofHit[], cap = 24): { points: number; reasons: string[] } {
  if (!hits.length) return { points: 0, reasons: [] };
  const PER_KIND: Record<ProofKind, number> = {
    credential: 4, // gate-keeping: you hold it or you do not
    domain: 3,     // did the actual work
    system: 2,     // used the tool
    scope: 2,      // shape of the seat
  };
  let raw = 0;
  for (const h of hits) raw += PER_KIND[h.kind] * h.weight;
  const points = Math.min(cap, raw);
  // Reasons read like a person wrote them, strongest first, deduped by term.
  const reasons: string[] = [];
  for (const h of hits.slice(0, 4)) {
    const what =
      h.kind === "credential" ? `holds ${h.matched}`
      : h.kind === "system" ? `works in ${h.matched}`
      : h.kind === "scope" ? `${h.matched} background`
      : `${h.matched} experience`;
    reasons.push(what);
  }
  return { points, reasons };
}
