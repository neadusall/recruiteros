/**
 * RecruitersOS · ORG CHART — who buys a given req, at a given company size.
 *
 * ONE model, consumed by every outbound lane (cold email in batch.mjs, voice drops, follow-ups),
 * so the person we email is always the person we call. Before this, targeting matched only the
 * FUNCTION: a req was "owned by Finance", and a CFO and an Accounting Manager were equally valid
 * buyers for a Staff Accountant opening. That is wrong in both directions — it mails the CFO about
 * a clerk, and it mails a manager about a Controller search — and it is why so much volume landed
 * on founders and C-suites who never reply.
 *
 * ── WHY IT IS BUILT THIS WAY (the evidence) ─────────────────────────────────────────────────────
 *
 * 1. SENIORITY. Published 2025-2026 B2B cold-outreach benchmarks are consistent on direction even
 *    where they disagree on absolute numbers: Director-level replies run several times higher than
 *    C-suite, with Directors reported around 4x CEOs, and VP/Director is repeatedly called the
 *    sweet spot — senior enough to buy, close enough to the pain to care, not buried in cold mail.
 *    C-suite reply rates sit at or under ~2% median. So the default target is the LOWEST person who
 *    can still buy, not the highest person we can name.
 *
 * 2. COMPANY SIZE decides how many layers exist to aim at. Org-design research puts a second
 *    management layer at roughly 250 employees, and above ~500 FTEs the finance function is
 *    explicitly multi-layered: a CFO supported by VPs of FP&A / Accounting / Treasury, each over
 *    Directors, Managers and Analysts. Below ~250 those layers do not exist, so the function head
 *    (or the owner) genuinely is the hiring manager. Above ~1,000 they always do, so the C-suite is
 *    the wrong door for anything but a leadership req.
 *
 * 3. THE REQ'S OWN LEVEL sets the floor. A hire's buyer is the person they would report to, or
 *    that person's boss. A Staff Accountant reports to an Accounting Manager or Controller; a
 *    Controller reports to a VP Finance or the CFO; a VP of Sales reports to the CRO. Targeting is
 *    therefore RELATIVE to the posting, never a fixed title per function.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────────────────
 *
 *   buyer level ∈ [ max(reqLevel + 1, MANAGER) , ceiling(size tier) ]   in the req's own function
 *
 * with the ceiling set by how many layers the company actually has:
 *
 *   flat        ≤250 employees    ceiling = C-level, and a whole-company owner/CEO is legitimate
 *   functional  251-1,000         ceiling = C-level of that function; the CEO is not the buyer
 *   layered     1,001+            ceiling = reqLevel + 2; the C-suite is too far from the req
 *
 * Worked examples, which are the cases to read first:
 *
 *   Staff Accountant  @ 150   -> Accounting Manager, Controller, CFO, or the owner   (flat)
 *   Staff Accountant  @ 2,000 -> Accounting Manager or Controller. NOT the CFO.      (layered)
 *   Controller        @ 2,000 -> VP of Finance or CFO                                (layered)
 *   VP of Sales       @ 2,000 -> CRO only                                            (layered)
 *   CFO               @ any   -> CEO / board (an executive search, handled as Executive)
 *
 * Everything below is data, not branching logic, so adding a function or retuning a tier is an
 * edit to a table. `describe()` renders the whole matrix for the UI and for tools/orgchart-print.
 */

/* ── Seniority ladder ─────────────────────────────────────────────────────────────────────────── */

export const LEVEL = { ic: 1, senior_ic: 2, manager: 3, director: 4, vp: 5, clevel: 6 };
export const LEVEL_NAME = { 1: "IC", 2: "Senior IC", 3: "Manager", 4: "Director", 5: "VP", 6: "C-level" };

/** Nobody below a manager buys recruiting services, whatever the req's own level. */
export const BUY_FLOOR = LEVEL.manager;

// Matched most-senior-first. Deliberately narrow: a miss costs us a level of precision, a false
// positive aims the whole campaign at the wrong door.
const LEVEL_PATTERNS = [
  // "general counsel" is listed explicitly: the top lawyer is a C-level seat but carries neither
  // "chief" nor an officer acronym, so without it a GC req read as an IC and routed nowhere.
  [LEVEL.clevel, /\b(chief\s+\w+(?:\s+\w+)?\s+officer|c[efoimrphts]o|chief\s+of\s+staff|general\s+counsel|president|founder|co-?founder|owner|partner|managing\s+(?:director|partner))\b/i],
  [LEVEL.vp, /\b(vice\s+president|vp|svp|evp|head\s+of|general\s+manager|\bgm\b)\b/i],
  // "Controller" is a Director-level seat in finance, and "Principal" / "Superintendent" are the
  // equivalent rung in consulting and construction. They rarely carry the word "director".
  [LEVEL.director, /\b(director|controller|comptroller|principal|superintendent|chair|dean)\b/i],
  [LEVEL.manager, /\b(manager|supervisor|foreman|team\s+lead|crew\s+lead|charge\s+nurse)\b/i],
  [LEVEL.senior_ic, /\b(senior|sr\.?|staff|lead|principal\s+engineer|iii|iv|specialist\s+ii)\b/i],
];

// "Staff X" is a SENIOR individual contributor in engineering and product, and an ENTRY-level seat
// in accounting ("Staff Accountant" is the classic first job). Same word, opposite rung, so it is
// resolved against the family rather than guessed.
const STAFF_IS_ENTRY = /\b(accountant|accounting|auditor|bookkeep\w*|analyst)\b/i;

/**
 * The seniority level of a posted role, or of a person's title. One function for both on purpose:
 * the comparison the whole model makes is "is this person above that req", so both sides must be
 * measured with the same ruler.
 */
export function levelOf(title) {
  const t = String(title || "").trim();
  if (!t) return LEVEL.ic;
  // Guard the assistant/deputy class before the C-level pattern: an "Assistant Controller" is a
  // manager, and an "Executive Assistant to the CFO" is not a CFO.
  const assistant = /\b(assistant|associate|deputy|coordinator|administrator|apprentice|intern)\b/i.test(t);
  for (const [lvl, re] of LEVEL_PATTERNS) {
    if (!re.test(t)) continue;
    if (lvl === LEVEL.senior_ic && /\bstaff\b/i.test(t) && STAFF_IS_ENTRY.test(t)) return LEVEL.ic;
    // An assistant/associate version of a seat sits one rung below it, floored at IC.
    if (assistant && lvl >= LEVEL.director) return Math.max(LEVEL.ic, lvl - 1);
    return lvl;
  }
  return LEVEL.ic;
}

/* ── Company size tiers ───────────────────────────────────────────────────────────────────────── */

export const TIERS = [
  {
    key: "flat", max: 250, label: "≤250 · flat",
    what: "One management layer. The function head often IS the hiring manager, and the owner or CEO is genuinely in the loop on individual reqs.",
    ceiling: "clevel", ownerBuys: true,
  },
  {
    key: "functional", max: 1000, label: "251-1,000 · functional",
    what: "Real function leaders exist (CFO, CRO, CTO). Target the function, not the company: the CEO is no longer the buyer for a normal req.",
    ceiling: "clevel", ownerBuys: false,
  },
  {
    key: "layered", max: Infinity, label: "1,001+ · layered",
    what: "The function itself is multi-layered. A junior req is owned by a Manager or Director and the C-suite is several rungs away from it.",
    ceiling: "relative", ownerBuys: false,
  },
];

/** Which tier a company sits in. An unknown headcount returns null: the caller decides how to fail. */
export function tierOf(headcount) {
  const n = Number(headcount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return TIERS.find((t) => n <= t.max) || TIERS[TIERS.length - 1];
}

/* ── The chain of command per function ────────────────────────────────────────────────────────── */

// Keyed by the function GROUP that gates.mjs already derives (roleFunctionGroup), so this table and
// the gate can never drift onto different vocabularies. Titles are ordered best-first within a rung
// and are used for the pitch, the org-chart display, and to tell the owner search what to hunt for.
export const CHAIN = {
  Finance: {
    clevel: ["Chief Financial Officer", "CFO", "Chief Accounting Officer"],
    vp: ["VP of Finance", "VP of Accounting", "SVP Finance"],
    director: ["Controller", "Corporate Controller", "Director of Finance", "Director of Accounting"],
    manager: ["Accounting Manager", "Finance Manager", "Assistant Controller"],
  },
  Sales: {
    clevel: ["Chief Revenue Officer", "CRO", "Chief Sales Officer", "Chief Commercial Officer"],
    vp: ["VP of Sales", "VP of Business Development", "SVP Sales"],
    director: ["Sales Director", "Director of Sales", "Director of Business Development"],
    manager: ["Sales Manager", "Business Development Manager"],
  },
  Marketing: {
    clevel: ["Chief Marketing Officer", "CMO"],
    vp: ["VP of Marketing", "SVP Marketing"],
    director: ["Marketing Director", "Director of Demand Generation", "Creative Director"],
    manager: ["Marketing Manager", "Demand Generation Manager"],
  },
  Engineering: {
    clevel: ["Chief Technology Officer", "CTO", "Chief Information Officer", "Chief Information Security Officer"],
    vp: ["VP of Engineering", "Head of Engineering", "VP of Technology"],
    director: ["Director of Engineering", "Director of IT", "Engineering Director"],
    manager: ["Engineering Manager", "IT Manager", "Software Development Manager"],
  },
  Product: {
    clevel: ["Chief Product Officer", "CPO"],
    vp: ["VP of Product", "Head of Product"],
    director: ["Director of Product Management", "Product Director"],
    manager: ["Product Manager", "Group Product Manager"],
  },
  Operations: {
    clevel: ["Chief Operating Officer", "COO"],
    vp: ["VP of Operations", "VP of Supply Chain", "VP of Manufacturing"],
    director: ["Director of Operations", "Plant Director", "Director of Supply Chain"],
    manager: ["Operations Manager", "Plant Manager", "Production Manager"],
  },
  "People / HR": {
    clevel: ["Chief Human Resources Officer", "CHRO", "Chief People Officer"],
    vp: ["VP of Human Resources", "VP of People", "Head of Talent"],
    director: ["Director of Human Resources", "HR Director", "Director of Talent Acquisition"],
    manager: ["HR Manager", "Talent Acquisition Manager"],
  },
  Legal: {
    clevel: ["General Counsel", "Chief Legal Officer", "Chief Compliance Officer"],
    vp: ["VP of Legal", "Deputy General Counsel"],
    director: ["Director of Legal Affairs", "Director of Compliance"],
    manager: ["Legal Operations Manager", "Compliance Manager"],
  },
  "Customer Success": {
    clevel: ["Chief Customer Officer", "Chief Experience Officer"],
    vp: ["VP of Customer Success", "Head of Customer Experience"],
    director: ["Director of Customer Success", "Director of Client Services"],
    manager: ["Customer Success Manager", "Client Services Manager"],
  },
  Clinical: {
    clevel: ["Chief Nursing Officer", "Chief Medical Officer", "Chief Clinical Officer"],
    vp: ["VP of Nursing", "VP of Clinical Operations"],
    director: ["Director of Nursing", "Clinical Director", "Director of Clinical Services"],
    manager: ["Nurse Manager", "Clinical Manager", "Practice Administrator"],
  },
  Executive: {
    clevel: ["Chief Executive Officer", "CEO", "President", "Owner", "Managing Partner"],
    vp: ["Chief Executive Officer"],
    director: ["Chief Executive Officer"],
    manager: ["Chief Executive Officer"],
  },
};

const LEVEL_KEY = { 3: "manager", 4: "director", 5: "vp", 6: "clevel" };

// "an IC req" / "a Manager req": the level names are user-facing text, so the article matters.
const aan = (w) => (/^[AEIOU]/i.test(String(w)) ? "An " : "A ") + w;

/* ── The target resolver ──────────────────────────────────────────────────────────────────────── */

/**
 * Who should receive the email AND the voice drop for this posting.
 *
 * Returns the acceptable BAND of seniority (min/max level), the ideal rung, the concrete titles to
 * hunt and to display, and a plain-English `why` that the UI and the hold logs both show. Callers
 * decide what to do with a buyer outside the band; this module never rejects anything itself, which
 * keeps it usable by the org-chart view, the owner search, and the gate alike.
 *
 * `headcount` may be null/unknown: the band then falls back to the widest reading (flat), because
 * refusing to target anything at all on an unresolved size would stall the whole desk.
 */
export function targetFor({ role, functionGroup, headcount }) {
  const reqLevel = levelOf(role);
  const tier = tierOf(headcount) || TIERS[0];
  const fn = CHAIN[functionGroup] ? functionGroup : null;

  // An executive search is its own case at every size: the CEO or board hires the C-suite.
  const isExecReq = functionGroup === "Executive" || reqLevel >= LEVEL.clevel;

  let min = Math.max(reqLevel + 1, BUY_FLOOR);
  let max;
  if (isExecReq) {
    min = LEVEL.clevel; max = LEVEL.clevel;
  } else if (tier.ceiling === "relative") {
    // Clamped to C-level: reqLevel + 2 overshoots the top of the ladder for a VP req and would
    // otherwise produce a level 7 that no title maps to, silently widening the band to nothing.
    max = Math.min(LEVEL.clevel, Math.max(reqLevel + 2, LEVEL.director));
  } else {
    max = LEVEL.clevel;
  }
  if (min > max) min = max;

  const levels = [];
  for (let l = min; l <= max; l++) if (LEVEL_KEY[l]) levels.push(l);
  const ideal = levels.length ? levels[0] : Math.min(max, LEVEL.clevel);

  const titlesAt = (l) => (fn && CHAIN[fn][LEVEL_KEY[l]]) || [];
  const titles = levels.flatMap(titlesAt);

  return {
    reqLevel,
    reqLevelName: LEVEL_NAME[reqLevel],
    functionGroup: fn || functionGroup || "Other",
    tier: tier.key,
    tierLabel: tier.label,
    ownerBuys: !!tier.ownerBuys || isExecReq,   // may we mail a whole-company exec / owner?
    isExecReq,
    min, max, ideal,
    idealTitles: titlesAt(ideal),
    titles,
    levels,
    why: isExecReq
      ? `${aan(LEVEL_NAME[reqLevel])} req is an executive search: the CEO or board is the buyer at any company size.`
      : tier.ceiling === "relative"
        ? `At ${tier.label}, ${fn || "the function"} is multi-layered, so ${aan(LEVEL_NAME[reqLevel])} req is owned at ${LEVEL_NAME[min]}${max !== min ? ` or ${LEVEL_NAME[max]}` : ""} level. The C-suite is too far from this req to be the buyer.`
        : tier.ownerBuys
          ? `At ${tier.label} there is one management layer, so anyone from ${LEVEL_NAME[min]} up to the owner is genuinely in the loop on this req.`
          : `At ${tier.label} real function leaders exist, so this req belongs to ${fn || "its function"} from ${LEVEL_NAME[min]} up to its C-level. The CEO is not the buyer.`,
  };
}

/**
 * Score a candidate buyer against the model. `rank` 0 is the ideal rung and rises as the buyer
 * drifts from it, so callers can ORDER prospects by fit rather than only accept or reject.
 */
export function fitOf({ role, functionGroup, headcount, buyerTitle, buyerFunction }) {
  const t = targetFor({ role, functionGroup, headcount });
  const lvl = levelOf(buyerTitle);
  const universal = buyerFunction === "universal";

  if (universal) {
    return t.ownerBuys
      ? { ok: true, rank: t.isExecReq ? 0 : 2, level: lvl, target: t, why: `whole-company buyer, legitimate at ${t.tierLabel}` }
      : { ok: false, level: lvl, target: t, why: `a whole-company exec is not the buyer for a ${t.reqLevelName} ${t.functionGroup} req at ${t.tierLabel}` };
  }
  if (buyerFunction && buyerFunction !== t.functionGroup && !t.isExecReq) {
    return { ok: false, level: lvl, target: t, why: `owns ${buyerFunction}, not the ${t.functionGroup} function this req sits in` };
  }
  if (lvl < t.min) {
    return { ok: false, level: lvl, target: t, why: `${LEVEL_NAME[lvl]} level is below the ${LEVEL_NAME[t.min]} who owns a ${t.reqLevelName} req` };
  }
  if (lvl > t.max) {
    return { ok: false, level: lvl, target: t, why: `${LEVEL_NAME[lvl]} level is above the ${LEVEL_NAME[t.max]} ceiling for a ${t.reqLevelName} req at ${t.tierLabel}` };
  }
  return { ok: true, rank: Math.abs(lvl - t.ideal), level: lvl, target: t, why: `${LEVEL_NAME[lvl]} in ${t.functionGroup}, inside the ${LEVEL_NAME[t.min]}-${LEVEL_NAME[t.max]} band for this req` };
}

/**
 * The whole model as data, for the org-chart view and tools/orgchart-print.mjs. One row per
 * (function × size tier × req level) so a recruiter can look up any posting and read who gets the
 * email and the voice drop, without needing to understand the rule that produced it.
 */
export function describe(functionGroups) {
  const fns = functionGroups && functionGroups.length ? functionGroups : Object.keys(CHAIN).filter((f) => f !== "Executive");
  const sampleFor = { 1: "Staff Accountant", 2: "Senior Accountant", 3: "Accounting Manager", 4: "Controller", 5: "VP of Finance" };
  const out = [];
  for (const fn of fns) {
    for (const tier of TIERS) {
      const head = tier.max === Infinity ? 2000 : Math.max(50, Math.round(tier.max * 0.6));
      for (const lvl of [LEVEL.ic, LEVEL.manager, LEVEL.director, LEVEL.vp]) {
        const t = targetFor({ role: sampleFor[lvl] || "", functionGroup: fn, headcount: head });
        // targetFor reads the LEVEL off the role string, so drive it directly for the matrix.
        const min = Math.max(lvl + 1, BUY_FLOOR);
        const max = tier.ceiling === "relative" ? Math.max(lvl + 2, LEVEL.director) : LEVEL.clevel;
        const levels = [];
        for (let l = Math.min(min, max); l <= max; l++) if (LEVEL_KEY[l]) levels.push(l);
        out.push({
          functionGroup: fn,
          tier: tier.key,
          tierLabel: tier.label,
          reqLevel: lvl,
          reqLevelName: LEVEL_NAME[lvl],
          buyerLevels: levels.map((l) => LEVEL_NAME[l]),
          buyerTitles: levels.flatMap((l) => (CHAIN[fn][LEVEL_KEY[l]] || []).slice(0, 2)),
          ownerBuys: !!tier.ownerBuys,
          why: t.why,
        });
      }
    }
  }
  return out;
}
