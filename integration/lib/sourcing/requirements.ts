/**
 * RecruitersOS · JD Sourcing · reading a requirement the way a profile states it.
 *
 * THE BUG THIS CLOSES (measured on prod ICPs, 2026-08-07). The scorer matched each
 * `mustHave` / `niceToHave` entry against a candidate with a whole-phrase, token-boundary
 * test. The JD parser emits those entries as SENTENCES, because that is how requirements
 * are written. Real examples off the desk's own runs:
 *
 *   "Hands-on Power BI development including report/dashboard authoring, DAX, and data modeling"
 *   "Active, hands-on NetSuite experience (not legacy-only ERP)"
 *   "Proven track record of personally closing new business (individual contributor selling)"
 *
 * A LinkedIn headline never contains a fourteen-word sentence, so the test could not
 * return true, and the entire domain component of the score (15 of 100 points, the only
 * part that asks whether someone can actually DO the job) sat dead on every run. That is
 * a large part of why scores bunched in the middle and no candidate in 25,320 ever
 * scored above 89.
 *
 * The fix is to read a requirement the way a profile states it: reduce the sentence to
 * the distinctive terms it is really about ("power bi", "dax", "netsuite", "asc 606"),
 * and count how many of the requirements a person shows evidence for, rather than
 * stopping at the first hit.
 *
 * Deterministic, free, no model call. The LLM-derived vocabulary in proofExtract.ts is a
 * different and complementary layer: this one only reads what the JD already said.
 */

/** Words that carry no matching power in a requirement sentence. Recruiting filler
 *  ("proven", "hands-on", "track record"), grammar, and units of time. If these were
 *  kept, "experience" alone would match nearly every profile on earth. */
const FILLER = new Set([
  "a", "an", "and", "or", "the", "of", "in", "on", "at", "to", "for", "with", "within",
  "from", "by", "as", "is", "are", "be", "been", "being", "not", "no", "any", "all",
  "including", "include", "includes", "such", "etc", "eg", "ie", "plus", "strong",
  "strongly", "preferred", "required", "must", "should", "able", "ability", "skills",
  "skill", "experience", "experienced", "experiences", "background", "knowledge",
  "proven", "demonstrated", "hands", "handson", "on", "track", "record", "years",
  "year", "yrs", "level", "senior", "junior", "mid", "excellent", "solid", "deep",
  "working", "work", "worked", "using", "use", "used", "familiar", "familiarity",
  "understanding", "expertise", "proficiency", "proficient", "responsible", "ownership",
  "own", "owns", "managing", "manage", "management", "full", "cycle", "end", "direct",
  "active", "current", "currently", "e", "g", "i", "very", "highly", "well", "other",
  "others", "related", "relevant", "similar", "equivalent", "minimum", "least", "over",
  "up", "least", "across", "through", "throughout", "their", "this", "that", "these",
  "who", "which", "what", "when", "where", "how", "new", "existing", "large", "small",
]);

/**
 * Words that may form a PAIR but must never count as a lone term.
 *
 * These are real, meaningful words — "azure data factory" and "data modeling" both need
 * "data" — but on their own they are so common in the industries we search that a single
 * hit proves nothing. Caught by the suite: a candidate whose headline read
 * "Data Analyst | Power BI reporting" was credited with meeting an Azure Data Factory
 * requirement, purely on the word "data". A false must-have credit is worse than a
 * missed one, because it promotes the wrong person past the outreach bar.
 *
 * Distinct from FILLER: filler is deleted outright, so it cannot appear in a pair either.
 */
const GENERIC_SINGLE = new Set([
  "data", "system", "systems", "platform", "platforms", "software", "tool", "tools",
  "process", "processes", "business", "team", "teams", "client", "clients", "customer",
  "customers", "project", "projects", "report", "reports", "reporting", "development",
  "support", "service", "services", "account", "accounts", "sales", "marketing",
  "finance", "financial", "operations", "operational", "analysis", "analytics",
  "analyst", "design", "product", "products", "program", "programs", "quality",
  "training", "planning", "budget", "strategy", "strategic", "research", "security",
  "network", "mobile", "web", "cloud", "digital", "technical", "technology", "general",
  "global", "regional", "national", "local", "corporate", "industry", "market",
  "markets", "company", "companies", "office", "staff", "people", "role", "roles",
  "position", "job", "jobs", "department", "leadership", "communication", "based",
]);

/** Tokens of a string, punctuation-collapsed. Mirrors score.ts so both sides agree. */
function tok(s: string): string[] {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);
}

/**
 * A requirement sentence reduced to the terms worth matching on.
 *
 * Keeps two shapes, because credentials arrive as both:
 *  - ADJACENT PAIRS of content words ("power bi", "azure databricks", "asc 606"), which
 *    is how tools and standards are actually written, and
 *  - single content words long enough to be distinctive ("netsuite", "dax", "epicor").
 *
 * Pairs are listed first so the more specific evidence is found first. A two-letter
 * single word is dropped: matching "bi" on its own would fire on "bi-weekly".
 */
export function requirementTerms(requirement: string): string[] {
  const words = tok(requirement);
  const content = words.filter((w) => !FILLER.has(w));
  const pairs: string[] = [];
  const singles: string[] = [];
  for (let i = 0; i < content.length; i++) {
    const w = content[i];
    // A number is only meaningful attached to something ("asc 606", "p 21"), never alone,
    // and a word that is common across a whole industry proves nothing on its own.
    const isNum = /^\d+$/.test(w);
    if (!isNum && w.length >= 3 && !GENERIC_SINGLE.has(w)) singles.push(w);
    const next = content[i + 1];
    // Pair adjacent content words only when they were adjacent in the SENTENCE too,
    // so "Power BI development including ... DAX" cannot invent the pair "bi dax".
    if (next && words.indexOf(next, words.indexOf(w)) === words.indexOf(w) + 1) {
      pairs.push(`${w} ${next}`);
    }
  }
  // Dedupe, pairs first, and cap: a long sentence should not get more shots on goal
  // than a short one just for being wordy.
  return [...new Set([...pairs, ...singles])].slice(0, 12);
}

/** Does the candidate's text show evidence for this one requirement? */
export function requirementMet(text: string, requirement: string): boolean {
  const hay = " " + tok(text).join(" ") + " ";
  for (const t of requirementTerms(requirement)) {
    if (hay.includes(" " + t + " ")) return true;
  }
  return false;
}

export interface RequirementCoverage {
  /** How many requirements the candidate shows evidence for. */
  met: number;
  /** How many were assessable at all. */
  total: number;
  /** 0..1. Zero when there was nothing to assess, so a caller can award nothing. */
  ratio: number;
  /** The matched requirements, shortened, for the human-readable reason line. */
  matched: string[];
}

/**
 * How many of a requirement list the candidate shows evidence for.
 *
 * COUNTING IS THE POINT. The old scorer stopped at the first hit, so someone meeting one
 * of five requirements scored exactly as well as someone meeting all five. Coverage is
 * what separates a real match from a coincidental word.
 */
export function requirementCoverage(text: string, requirements: string[]): RequirementCoverage {
  const usable = (requirements || []).filter((r) => requirementTerms(r).length > 0);
  if (!usable.length) return { met: 0, total: 0, ratio: 0, matched: [] };
  const matched: string[] = [];
  for (const r of usable) if (requirementMet(text, r)) matched.push(r);
  return {
    met: matched.length,
    total: usable.length,
    ratio: matched.length / usable.length,
    matched,
  };
}

/** A requirement sentence trimmed to something readable in a reason line. */
export function shortenRequirement(requirement: string, max = 42): string {
  const clean = (requirement || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  // Cut at a word boundary so the reason never ends mid-word.
  const cut = clean.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > 12 ? cut.slice(0, sp) : cut) + "...";
}
