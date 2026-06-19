/**
 * RecruitersOS · In-Market · Real-employer resolution
 *
 * "Reach the company that is ACTUALLY hiring — never the staffing/recruiting agency that
 * posted the role on their behalf." Two jobs, both free + deterministic (no network, no
 * clock, no LLM), so they run on every lead at collection time without touching the
 * enrichment budget:
 *
 *   1. classifyEmployer(name)  — is this "company" really a staffing / recruiting / RPO /
 *                                placement firm rather than the end employer?
 *   2. unmaskEmployer(text)    — when an agency posted the role, pull the real client out
 *                                of the job text ("our client, a leading fintech…").
 *
 * Why it matters most at scale: direct ATS boards (Greenhouse/Lever/Ashby) are company-
 * owned, so the board owner is almost always the true employer. The staffing problem is
 * concentrated in the AGGREGATORS (Adzuna/Indeed/remote boards) — exactly the breadth feeds
 * you'd lean on to push volume. So this gate is what keeps a 10-20K/day pull pointed at real
 * hiring managers instead of recruiters competing with us.
 *
 * Design bias: HIGH PRECISION. A false positive here deletes a real lead, so the lexicon is
 * tuned to fire only on unambiguous agency tells, and an allowlist protects recruiting-TECH
 * vendors (Greenhouse, Gem, Ashby…) that are legitimate employers, not agencies.
 */

import { companyAnchor } from "../signals/hiring/normalize";

/* ------------------------------------------------------------------ */
/* Result shape                                                        */
/* ------------------------------------------------------------------ */

export type EmployerCategory = "staffing" | "recruiting" | "rpo" | "consulting_placement" | "job_board";

export interface EmployerVerdict {
  /** True when the named "company" is an intermediary, not the end employer. */
  isStaffing: boolean;
  /** 0..1 strength of the call (only meaningful when isStaffing). */
  confidence: number;
  /** Which kind of intermediary, when known. */
  category?: EmployerCategory;
  /** Human-readable why, e.g. 'name contains "staffing"'. */
  reason?: string;
}

/* ------------------------------------------------------------------ */
/* Known intermediary brands (anchored, so suffixes/casing don't matter)*/
/* ------------------------------------------------------------------ */

/**
 * Major staffing / recruiting / RPO brands that routinely appear as the "company" on
 * aggregators while the real employer is their client. Stored as companyAnchor() values so
 * "Robert Half International" and "Robert Half, Inc." both match "roberthalf". A hit here is
 * high-confidence on the name alone.
 */
const KNOWN_INTERMEDIARIES: ReadonlySet<string> = new Set([
  // Generalist staffing giants
  "roberthalf", "randstad", "adecco", "manpower", "manpowergroup", "kelly", "kellyservices",
  "insightglobal", "teksystems", "aerotek", "actalent", "kforce", "modis", "experis",
  "spherion", "volt", "trueblue", "peoplelink", "staffmark", "adia", "bartech",
  // Tech / IT staffing + consultancies that staff reqs
  "collabera", "apexsystems", "apex", "cybercoders", "motionrecruitment", "jobot",
  "signaturejobs", "diversant", "kforcetechnology", "matlentech", "nuagebiztech",
  "judgegroup", "thejudgegroup", "harnham", "averityrecruiting", "averity",
  "syntricate", "vaco", "beaconhill", "beaconhillstaffing", "ledgent", "roth",
  "infosysbpm", "cognizant", "accenturestaffing", "wipro", "hcl", "ust", "ustglobal",
  // Executive search / headhunters
  "kornferry", "heidrickstruggles", "russellreynolds", "spencerstuart", "egonzehnder",
  "michaelpage", "pagegroup", "hays", "robertwalters", "harveynash", "lhh",
  "korn", "diversifiedsearch", "trueserach", "truesearch", "daversa", "riviera",
  "jordansearch", "betts", "bettsrecruiting", "longterm", "tcg", "tcgconsulting",
  // Healthcare / clinical staffing
  "amnhealthcare", "amn", "crosscountry", "crosscountryhealthcare", "medicalsolutions",
  "aya", "ayahealthcare", "maxim", "maximhealthcare", "favoritehealthcare", "supplementalhealthcare",
  // RPO / talent-solutions arms
  "cielotalent", "cielo", "pontoon", "alexandermann", "amsourcing", "hudsonrpo",
  "sevenstep", "orionrpo", "korntalent",
]);

/**
 * Recruiting/HR-TECH companies whose names trip the lexicon ("talent", "hire", "recruit",
 * "gem") but are legitimate PRODUCT employers we DO want to reach. Anchored allowlist —
 * checked before the lexicon so we never suppress these.
 */
const RECRUITING_TECH_ALLOWLIST: ReadonlySet<string> = new Set([
  "greenhouse", "lever", "ashby", "ashbyhq", "gem", "gemhq", "workable", "smartrecruiters",
  "recruitee", "jobvite", "bamboohr", "rippling", "gusto", "deel", "remote", "lattice",
  "hibob", "bob", "checkr", "vetty", "handshake", "indeed", "ziprecruiter", "linkedin",
  "hired", "angellist", "wellfound", "fountain", "fountainpay", "metaview", "brighthire",
  "paradox", "sense", "phenom", "eightfold", "beamery", "seekout", "gloat", "findem",
  "covey", "dover", "pinpoint", "teamtailor", "workday", "icims", "lessonly",
]);

/* ------------------------------------------------------------------ */
/* Lexicon tells (token-level, word-boundary matched)                  */
/* ------------------------------------------------------------------ */

interface Tell {
  re: RegExp;
  category: EmployerCategory;
  weight: number;
  label: string;
}

/**
 * Word-boundary patterns over the RAW company name. Weighted: a strong, unambiguous tell
 * ("staffing", "recruitment agency") alone clears the bar; weaker, polysemous tells
 * ("solutions", "consulting") need corroboration. `\b` boundaries keep "staffing" from
 * matching inside an unrelated word and keep "RPO" from matching "airport".
 */
const TELLS: Tell[] = [
  { re: /\bstaffing\b/i, category: "staffing", weight: 0.95, label: 'name contains "staffing"' },
  { re: /\brecruit(?:ing|ment|er|ers)?\b/i, category: "recruiting", weight: 0.9, label: 'name contains "recruiting"' },
  { re: /\bheadhunters?\b/i, category: "recruiting", weight: 0.95, label: 'name contains "headhunters"' },
  { re: /\b(?:executive|retained)\s+search\b/i, category: "recruiting", weight: 0.9, label: 'name contains "executive search"' },
  { re: /\btalent\s+(?:solutions|partners|acquisition|group|advisors|network)\b/i, category: "recruiting", weight: 0.85, label: 'name contains "talent solutions/partners"' },
  { re: /\b(?:rpo|recruitment\s+process\s+outsourcing)\b/i, category: "rpo", weight: 0.9, label: 'name contains "RPO"' },
  { re: /\bplacements?\b/i, category: "consulting_placement", weight: 0.75, label: 'name contains "placement"' },
  { re: /\bmanpower\b/i, category: "staffing", weight: 0.9, label: 'name contains "manpower"' },
  { re: /\bpersonnel\b/i, category: "staffing", weight: 0.7, label: 'name contains "personnel"' },
  { re: /\bworkforce\s+solutions\b/i, category: "staffing", weight: 0.8, label: 'name contains "workforce solutions"' },
  { re: /\bhr\s+solutions\b/i, category: "rpo", weight: 0.7, label: 'name contains "HR solutions"' },
  { re: /\bemployment\s+agency\b/i, category: "staffing", weight: 0.95, label: 'name contains "employment agency"' },
  { re: /\b(?:contract|temp|temporary)\s+staffing\b/i, category: "staffing", weight: 0.95, label: "temp/contract staffing" },
  // Weak, corroboration-only tells (never fire alone).
  { re: /\bconsult(?:ing|ants?)\b/i, category: "consulting_placement", weight: 0.35, label: 'name contains "consulting"' },
  { re: /\b(?:resourc(?:e|ing)|sourcing)\b/i, category: "recruiting", weight: 0.35, label: 'name contains "resourcing/sourcing"' },
  { re: /\b&\s*associates\b/i, category: "recruiting", weight: 0.4, label: 'name contains "& associates"' },
  { re: /\bsearch\s+(?:group|partners|firm|associates)\b/i, category: "recruiting", weight: 0.72, label: 'name contains "search group/partners"' },
];

const ACCEPT_AT = 0.7; // confidence threshold to call something a staffing intermediary

/* ------------------------------------------------------------------ */
/* Classifier                                                          */
/* ------------------------------------------------------------------ */

/**
 * Decide whether a company name belongs to a staffing/recruiting intermediary rather than a
 * real end employer. Pure + deterministic. Returns isStaffing=false (confidence 0) for the
 * overwhelming majority of real companies.
 */
export function classifyEmployer(name: string | undefined | null): EmployerVerdict {
  const raw = (name ?? "").trim();
  if (!raw) return { isStaffing: false, confidence: 0 };

  const anchor = companyAnchor(raw);

  // 1) Allowlist: legitimate recruiting/HR-tech employers are never intermediaries.
  if (anchor && RECRUITING_TECH_ALLOWLIST.has(anchor)) {
    return { isStaffing: false, confidence: 0 };
  }

  // 2) Known brand: high-confidence on the name alone.
  if (anchor && KNOWN_INTERMEDIARIES.has(anchor)) {
    return { isStaffing: true, confidence: 0.97, category: "staffing", reason: `known staffing/recruiting brand "${raw}"` };
  }

  // 3) Lexicon: sum weighted tells, keep the strongest as the stated reason. Two weak tells
  //    can corroborate into a call; one strong tell stands alone.
  let total = 0;
  let best: Tell | undefined;
  for (const t of TELLS) {
    if (t.re.test(raw)) {
      total += t.weight;
      if (!best || t.weight > best.weight) best = t;
    }
  }
  if (best && total >= ACCEPT_AT) {
    return {
      isStaffing: true,
      confidence: Math.min(0.99, total),
      category: best.category,
      reason: best.label,
    };
  }

  return { isStaffing: false, confidence: 0 };
}

/** Convenience boolean wrapper. */
export function isStaffingFirm(name: string | undefined | null): boolean {
  return classifyEmployer(name).isStaffing;
}

/* ------------------------------------------------------------------ */
/* Real-employer unmasking                                             */
/* ------------------------------------------------------------------ */

/**
 * When an agency posted a role, the real client is often named in the job text. These
 * patterns capture the most common phrasings; each returns the captured employer name. Order
 * matters — more specific patterns first.
 */
// The capture group stays case-SENSITIVE (`[A-Z]` start) so it grabs a proper-noun employer
// and not "a leading fintech"; only the lead keyword is made capitalization-tolerant (job
// text routinely starts a sentence with "Our client…" / "On behalf of…").
const UNMASK_PATTERNS: RegExp[] = [
  // "our client, Acme Corp," / "Our client Acme Corp is"
  /\b[Oo]ur\s+[Cc]lient[,:]?\s+(?:is\s+)?([A-Z][A-Za-z0-9&.\-' ]{2,60}?)(?:[,.]|\s+(?:is|are|has|seeks|a\s|an\s|the\s|—|-))/,
  // "on behalf of Acme Corp"
  /\b[Oo]n\s+behalf\s+of\s+([A-Z][A-Za-z0-9&.\-' ]{2,60}?)(?:[,.]|\s+(?:is|are|has|we|to|—|-))/,
  // "partnering with Acme Corp" / "partnered with Acme Corp"
  /\b[Pp]artner(?:ing|ed)?\s+with\s+([A-Z][A-Za-z0-9&.\-' ]{2,60}?)(?:[,.]|\s+(?:is|are|has|to|—|-))/,
  // 'client "Acme Corp"' / 'client company "Acme Corp"'
  /\b[Cc]lient\s+(?:company\s+)?["“]([A-Z][A-Za-z0-9&.\-' ]{2,60}?)["”]/,
  // "representing Acme Corp"
  /\b[Rr]epresenting\s+([A-Z][A-Za-z0-9&.\-' ]{2,60}?)(?:[,.]|\s+(?:is|are|in|for|—|-))/,
];

/** Generic phrases the capture group should never resolve to (anonymous clients). */
const ANON_CLIENT = /^(a|an|the|our|one|leading|fast|growing|global|top|major|well|premier|world|stealth|confidential|established)\b/i;

/**
 * Best-effort: pull the real employer name out of an agency-posted job's text. Returns null
 * when the client is anonymous ("our client, a leading fintech") or no pattern matches — the
 * caller then drops the lead rather than target the agency.
 */
export function unmaskEmployer(text: string | undefined | null): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length < 8) return null;
  for (const re of UNMASK_PATTERNS) {
    const m = t.match(re);
    const cand = m?.[1]?.trim().replace(/[.,'"]+$/, "").trim();
    if (cand && cand.length >= 2 && !ANON_CLIENT.test(cand)) {
      // Guard: the "real employer" must not itself be a staffing firm (agency naming a sub-agency).
      if (!isStaffingFirm(cand)) return cand;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Lead-level resolution                                               */
/* ------------------------------------------------------------------ */

export type EmployerResolution =
  | { kind: "employer" }                                  // already a real employer — keep as-is
  | { kind: "unmasked"; realEmployer: string; reason: string } // agency, but client recovered
  | { kind: "drop"; reason: string };                     // agency, client anonymous — drop

/**
 * One call the lead pipeline uses per lead: keep real employers, rewrite to the unmasked
 * client when an agency named it, or signal a drop when the agency hid an anonymous client.
 *
 * `text` should be whatever job text is available (signal detail + title); unmasking is
 * best-effort and only consulted when the named company looks like an intermediary.
 */
export function resolveRealEmployer(
  companyName: string | undefined | null,
  text?: string | null,
): EmployerResolution {
  const verdict = classifyEmployer(companyName);
  if (!verdict.isStaffing) return { kind: "employer" };
  const real = unmaskEmployer(text);
  if (real) return { kind: "unmasked", realEmployer: real, reason: verdict.reason ?? "staffing intermediary" };
  return { kind: "drop", reason: verdict.reason ?? "staffing intermediary" };
}
