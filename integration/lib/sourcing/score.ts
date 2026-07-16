/**
 * RecruitersOS · JD Sourcing
 * Rule-based fit scoring of a discovered candidate against the ICP.
 *
 * Deterministic and free ($0, no model call) so we can score thousands of rows
 * instantly. This is the cheap TRIAGE layer — it orders candidates and decides who
 * earns a (paid) deep-vet; the LLM deep-vet (deepVet.ts) is the real qualifier that
 * reads full work history. Stage-1's job is to be an honest, interpretable pre-vet rank.
 *
 * Design (weighted + normalized to 100, so the score reads like "% fit"):
 *   function match 35 · seniority match 20 · target company/industry 15 ·
 *   geography 15 · domain/must-have 15.
 * Plus seniority MISMATCH penalties (too junior / overqualified), soft negatives,
 * and a cap when there's no title to assess. Hard disqualifiers zero the row.
 *
 * Matching is token/phrase-boundary based — "Salesforce" no longer counts as "Sales",
 * and "VP of Engineering" no longer matches a "VP Sales" ICP on the word "VP".
 */

import type { CandidateICP, CandidateRow } from "./types";

/* ------------------------------------------------------------------ */
/* Tokenization & boundary-aware matching                              */
/* ------------------------------------------------------------------ */

function tokens(s: string | undefined): string[] {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);
}

/** Token-boundary phrase match: "sales" hits "vp of sales" but NOT "salesforce". */
function phraseHit(text: string, phrase: string): boolean {
  const t = " " + tokens(text).join(" ") + " ";
  const p = tokens(phrase).join(" ");
  return p.length > 0 && t.includes(" " + p + " ");
}

/** First phrase from `needles` that hits `text` (token-boundary), or null. */
function anyPhrase(text: string, needles: string[]): string | null {
  for (const n of needles) if (n && phraseHit(text, n)) return n;
  return null;
}

/** "City, ST" state abbreviations expanded to full names so "Brooklyn, NY" matches a
 *  target geo of "New York". Only expands after a comma (the standard location shape),
 *  so prose words like "or"/"in"/"me" are never touched. */
const US_STATE_FULL: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado",
  ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho",
  il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana",
  me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota",
  ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada",
  nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york",
  nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon",
  pa: "pennsylvania", ri: "rhode island", sc: "south carolina", sd: "south dakota",
  tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington",
  wv: "west virginia", wi: "wisconsin", wy: "wyoming",
};
function expandUsStateAbbrevs(text: string): string {
  return text.replace(/,\s*([a-z]{2})\b/g, (m, ab: string) => (US_STATE_FULL[ab] ? ", " + US_STATE_FULL[ab] + " " + ab : m));
}

/**
 * Is this candidate's stated location inside the target geos?
 *  true  = matches a target geo · false = states a DIFFERENT place · undefined = no
 *  location on the row (unknowable, treat as neutral). Shared by the scorer's geo
 *  component and discovery's strict-location drop so both agree on what "local" means.
 */
export function inTargetGeo(location: string | undefined, geos: string[]): boolean | undefined {
  const locText = expandUsStateAbbrevs((location || "").toLowerCase().trim());
  if (!locText) return undefined;
  if (!geos || !geos.length) return true;
  const expandedGeos = geos.map((g) => expandUsStateAbbrevs(g.toLowerCase()));
  return Boolean(anyPhrase(locText, expandedGeos));
}

/* ------------------------------------------------------------------ */
/* Seniority bands                                                     */
/* ------------------------------------------------------------------ */

type Band = "ic" | "manager" | "director" | "vp" | "exec";
const RANK: Record<Band, number> = { ic: 0, manager: 1, director: 2, vp: 3, exec: 4 };

const VP_MARKERS = ["vice president", "vp", "rvp", "avp", "area vice president", "regional vice president"];
const EXEC_MARKERS = ["chief", "ceo", "cfo", "coo", "cto", "cmo", "cro", "cio", "ciso", "svp", "evp", "senior vice president", "executive vice president", "president", "founder", "co founder", "owner", "managing partner", "managing director", "partner"];
const DIRECTOR_MARKERS = ["director", "head of", "vp of"]; // "vp of" already caught above; harmless
const MANAGER_MARKERS = ["manager", "supervisor", "team lead", "lead"];

/** Infer the candidate's seniority band from their title/headline text. */
function detectBand(titleText: string): Band {
  // VP before EXEC so "vice president" isn't swallowed by the "president" marker.
  if (anyPhrase(titleText, VP_MARKERS)) return "vp";
  if (anyPhrase(titleText, EXEC_MARKERS)) return "exec";
  if (anyPhrase(titleText, DIRECTOR_MARKERS)) return "director";
  if (anyPhrase(titleText, MANAGER_MARKERS)) return "manager";
  return "ic";
}

/* ------------------------------------------------------------------ */
/* Function terms derived from the ICP titles                          */
/* ------------------------------------------------------------------ */

const SENIORITY_WORDS = new Set([
  "vp", "svp", "evp", "rvp", "avp", "vice", "president", "chief", "head", "of",
  "director", "senior", "sr", "junior", "jr", "lead", "manager", "mgr", "regional",
  "area", "global", "national", "executive", "officer", "co", "founder", "owner",
  "principal", "the", "and", "for", "a", "an",
]);

/** Strip seniority/leadership words from an ICP title to leave its FUNCTION phrase. */
function functionPhrase(title: string): string {
  return tokens(title).filter((w) => !SENIORITY_WORDS.has(w) && w.length >= 3).join(" ");
}

/** Unique function tokens across all ICP titles (for partial overlap credit). */
function functionTerms(icp: CandidateICP): Set<string> {
  const out = new Set<string>();
  const src = icp.titles.length ? icp.titles : [];
  for (const t of src) for (const w of functionPhrase(t).split(" ")) if (w) out.add(w);
  // Fall back to industry tokens if the titles carried no function words.
  if (!out.size) for (const ind of icp.industries) for (const w of tokens(ind)) if (w.length >= 3) out.add(w);
  return out;
}

/* ------------------------------------------------------------------ */
/* Soft negatives                                                      */
/* ------------------------------------------------------------------ */

const SOFT_NEGATIVES = ["intern", "internship", "student", "trainee", "apprentice", "volunteer", "freelance", "freelancer", "seeking", "open to work", "unemployed"];

/* ------------------------------------------------------------------ */
/* Scorer                                                              */
/* ------------------------------------------------------------------ */

const WEIGHTS = { fn: 35, seniority: 20, company: 15, geo: 15, domain: 15 };

export function scoreCandidate(row: CandidateRow, icp: CandidateICP): { fitScore: number; fitReasons: string[] } {
  const fullText = [row.title, row.headline, row.company, row.location].filter(Boolean).join(" · ");
  const titleText = (row.title || row.headline || "").trim();
  const reasons: string[] = [];

  // Hard disqualifiers zero the row immediately.
  const dq = anyPhrase(fullText, icp.disqualifiers);
  if (dq) return { fitScore: 0, fitReasons: [`Disqualified: matches "${dq}"`] };

  // No title to judge — we can't assess fit; cap low so company/geo can't inflate it.
  if (!titleText) {
    let s = 0;
    if (anyPhrase((row.location || "").toLowerCase(), icp.geos)) { s += 8; reasons.push("In-target geo (no title to assess)"); }
    if (anyPhrase((row.company || "").toLowerCase(), icp.targetCompanies)) { s += 10; reasons.push("At target company (no title to assess)"); }
    reasons.unshift("No title on the record — can't verify fit");
    return { fitScore: Math.min(25, s), fitReasons: reasons };
  }

  let score = 0;

  /* 1. Function match (35) — what the person actually does. */
  const titlePhrases = (icp.titles.length ? icp.titles : []).map(functionPhrase).filter(Boolean);
  const exactFn = titlePhrases.find((p) => phraseHit(titleText, p));
  if (exactFn) {
    score += WEIGHTS.fn; reasons.push(`Function match: "${exactFn}"`);
  } else {
    const terms = functionTerms(icp);
    const tt = new Set(tokens(titleText));
    const hits = [...terms].filter((w) => tt.has(w));
    if (hits.length) {
      const partial = Math.min(WEIGHTS.fn - 7, hits.length * 14); // 1 hit→14, 2→28, capped < exact
      score += partial; reasons.push(`Partial function match: ${hits.slice(0, 3).join(", ")}`);
    } else {
      reasons.push("No function match — likely a different role family");
    }
  }

  /* 2. Seniority match (20) with mismatch penalties. */
  const candBand = detectBand(titleText);
  const targetRank = RANK[(icp.seniority as Band) ?? "director"];
  const diff = candBand ? RANK[candBand] - targetRank : 0;
  const ad = Math.abs(diff);
  if (ad === 0) { score += WEIGHTS.seniority; reasons.push(`Seniority on target (${candBand})`); }
  else if (ad === 1) { score += 12; reasons.push(`Seniority within one band (${candBand} vs ${icp.seniority})`); }
  else if (ad === 2) { score += 4; reasons.push(diff < 0 ? `Likely too junior (${candBand})` : `Likely overqualified (${candBand})`); }
  else { reasons.push(diff < 0 ? `Far too junior (${candBand})` : `Far overqualified (${candBand})`); }
  if (icp.managesTeam && RANK[candBand] < RANK.manager) { score = Math.max(0, score - 6); reasons.push("Role needs a people-manager — candidate looks IC"); }

  /* 3. Target company / industry (15). */
  const companyText = (row.company || "").toLowerCase();
  const co = anyPhrase(companyText, icp.targetCompanies);
  if (co) { score += WEIGHTS.company; reasons.push(`At target company ${co}`); }
  else {
    const ind = anyPhrase([row.company, row.headline].filter(Boolean).join(" "), icp.industries);
    if (ind) { score += 8; reasons.push(`Adjacent — in-industry (${ind})`); }
  }

  /* 4. Geography (15 bonus, and a REAL penalty for a known out-of-area location). */
  const locText = expandUsStateAbbrevs((row.location || "").toLowerCase());
  const geo = anyPhrase(locText, icp.geos.map((g) => expandUsStateAbbrevs(g.toLowerCase())));
  if (geo) { score += WEIGHTS.geo; reasons.push(`In-target geo (${geo})`); }
  else if (locText && icp.geos.length) {
    // The candidate TELLS us where they are and it is not a target geo. For a
    // location-pinned search that is disqualifying-adjacent, not neutral; without
    // this, a strong title match anywhere in the country outranks a local.
    score = Math.max(0, score - 18);
    reasons.push(`Outside target geos (${row.location})`);
  }
  // A row with NO location stays neutral: snippets often omit it, and the person
  // may still be local. Remote vs on-site is not a qualification signal either.

  /* 5. Domain / must-have signals (15). */
  let domain = 0;
  const mh = anyPhrase(fullText, icp.mustHave);
  if (mh) { domain += 9; reasons.push(`Must-have signal "${mh}"`); }
  const ind2 = anyPhrase(fullText, icp.industries);
  if (ind2) { domain += 4; reasons.push(`Domain signal "${ind2}"`); }
  const nh = anyPhrase(fullText, icp.niceToHave);
  if (nh) { domain += 2; reasons.push(`Nice-to-have "${nh}"`); }
  score += Math.min(WEIGHTS.domain, domain);

  /* Soft negatives — penalize junior/transient markers on a senior search. */
  if (targetRank >= RANK.director) {
    const neg = anyPhrase(fullText, SOFT_NEGATIVES);
    if (neg) { score = Math.max(0, score - 15); reasons.push(`Soft negative for a senior role: "${neg}"`); }
  }

  return { fitScore: Math.max(0, Math.min(100, Math.round(score))), fitReasons: reasons };
}
