/**
 * RecruitersOS · JD Sourcing — PROOF PLAN: what counts as evidence for THIS role.
 *
 * Bridges the two sources of long-tail vocabulary:
 *   1) the standing library in proofTerms.ts (what the vertical always cares about), and
 *   2) whatever this particular job description asked for.
 *
 * WHY THE JD SIDE NEEDS NO NEW LLM CALL OR PROMPT CHANGE. parseJobDescription already
 * tells the model to file skills, tools, licences and certifications into `niceToHave`,
 * with the genuinely non-negotiable ones (a required CPA, a required RN) in `mustHave`.
 * Those fields have been getting parsed all along and then almost entirely wasted: they
 * never reached a single search query, and in scoring they were worth a flat +9 / +2 on
 * FIRST HIT ONLY, matched against title and headline. Five must-haves scored the same as
 * one. So the vocabulary was already in the data; nothing was reading it properly.
 *
 * Reading it properly means being picky about what can go in a search. `niceToHave` also
 * collects things like "strong communication skills", which is real guidance for a human
 * and useless in an X-ray: no profile says it, and a query carrying it returns noise. So
 * a JD term earns its way into the query matrix only if it looks like EVIDENCE: a known
 * library term, an acronym, something with a number in it ("ASC 740", "Form 1065"), or a
 * short specific noun phrase. Everything else still scores, it just does not steer a search.
 *
 * Pure module: no I/O, no model calls. Tested by scripts/test-sourcing-proof.mts.
 */

import type { CandidateICP } from "./types";
import {
  type ProofTerm, type ProofVertical,
  detectVerticals, termsForVerticals, proofQueryGroups,
} from "./proofTerms";
import { applyTermStats } from "./proofStats";

export interface ProofPlan {
  /** Which shelves of the library this role drew on (may be empty for an off-book role). */
  verticals: ProofVertical[];
  /** Everything that counts as evidence for this role: library, JD, and derived. */
  terms: ProofTerm[];
  /** Ready-to-drop X-ray fragments: ("CPA" OR "ASC 740" OR ...). */
  queryGroups: string[];
  /** Terms that came from the JD rather than the library, for the UI's "searching for" line. */
  fromJd: string[];
  /** Terms derived for this role because no curated shelf covered it. */
  derived?: string[];
  /** Terms measured as absent from this market and retired, for an honest readout. */
  dropped?: string[];
}

/** Soft-skill and filler language that shows up in niceToHave and must never steer a search. */
const NOT_EVIDENCE = [
  "communication", "communicator", "team player", "detail oriented", "detail-oriented",
  "self starter", "self-starter", "motivated", "organized", "organizational skills",
  "problem solving", "problem-solving", "interpersonal", "time management", "multitask",
  "fast paced", "fast-paced", "work ethic", "leadership skills", "collaborative",
  "written and verbal", "analytical skills", "attention to detail", "critical thinking",
  "bachelor", "bachelors", "master", "masters", "degree", "years of experience",
  "excellent", "strong", "proficient", "ability to", "willingness", "passion",
];

/**
 * Could this phrase plausibly appear on a LinkedIn profile as proof of doing the work?
 *
 * Biased toward rejection. A false accept costs a wasted query and a diluted score; a
 * false reject costs nothing, because the term still travels to the deep-vet prompt and
 * the recruiter's own reading. Precision is the whole point of this feature.
 */
export function isSearchableEvidence(raw: string): boolean {
  const s = (raw || "").trim();
  if (s.length < 2 || s.length > 42) return false;
  const low = s.toLowerCase();
  if (NOT_EVIDENCE.some((n) => low.includes(n))) return false;
  // Bracketed annotation is the signature of requirement language, not profile language.
  // A real run produced "CPA license (active)" as a search term: it matches nobody (no
  // profile is written that way), and it burned a query slot while duplicating "CPA".
  if (/[()\[\]]/.test(s)) return false;
  // Requirement qualifiers give the same tell in prose form.
  if (/\b(required|preferred|desired|a plus|or equivalent|must have|minimum|active|current)\b/.test(low)) return false;
  // Wordy phrases are descriptions, not the words people put on profiles.
  const words = low.split(/\s+/).filter(Boolean);
  if (words.length > 4) return false;
  // An acronym is the highest-signal shape there is: CPA, BCBA, PDPM, ASC.
  if (/^[A-Z][A-Z0-9&/.-]{1,9}$/.test(s)) return true;
  // A number inside a phrase almost always means a standard, form or code:
  // "ASC 740", "Form 1065", "10-K", "ASC 842", "Six Sigma" (no number, caught below).
  if (/\d/.test(s) && words.length <= 4) return true;
  // Named products and proper nouns: NetSuite, PointClickCare, Epic, CentralReach.
  if (/^[A-Z][A-Za-z0-9]+( [A-Z][A-Za-z0-9]+)?$/.test(s) && words.length <= 2) return true;
  // Short specific domain phrases: "transfer pricing", "skilled nursing", "month-end close".
  // The article guard requires actual whitespace, not \b: a word boundary sits between
  // "a" and "&", so \b silently rejected every term beginning "A&" ("A&P License", the
  // aviation mechanic's licence, and anything else shaped like it).
  if (words.length >= 2 && words.length <= 3 && !/^(the|a|an|and|or|of|in|with|for)\s/.test(low)) return true;
  return false;
}

/**
 * Build the evidence plan for a run.
 *
 * `mustHave` outranks `niceToHave` because the JD said so, and both outrank a library
 * term of the same name: a role that explicitly demands a CPA should score a CPA higher
 * than the shelf default. Library terms fill in everything the JD forgot to say out
 * loud, which is most of the vocabulary in practice: job descriptions rarely list
 * "PointClickCare" even when every good candidate has it.
 */
export function buildProofPlan(
  icp: CandidateICP,
  jdText = "",
  opts: {
    maxGroups?: number;
    perGroup?: number;
    /** Vocabulary derived for this role by proofExtract, for markets the curated library
     *  does not cover. Ranked BELOW curated terms of the same name: a human who knows the
     *  vertical beats a general model on the same question. */
    derived?: ProofTerm[];
    /** Measured yield from proofStats, which retires terms this market does not actually
     *  use and keeps saturated ones out of the query matrix. */
    stats?: Record<string, { seen: number; hits: number }>;
  } = {},
): ProofPlan {
  // Vertical detection reads the JD plus the parsed role language, so a thin JD still
  // lands on the right shelf via its titles and industries.
  const hay = [jdText, icp.label, ...(icp.titles || []), ...(icp.industries || [])].join(" ");
  const verticals = detectVerticals(hay);
  const library = termsForVerticals(verticals);

  // Index the library so a JD term that names something we already know ("Certified
  // Public Accountant") is folded into the canonical entry (CPA) with all its aliases,
  // rather than being added again as a weaker duplicate.
  const bySurface = new Map<string, ProofTerm>();
  for (const t of library) {
    bySurface.set(t.term.toLowerCase(), t);
    for (const a of t.aliases || []) bySurface.set(a.toLowerCase(), t);
  }

  const terms: ProofTerm[] = [...library];
  const seen = new Set(terms.map((t) => t.term.toLowerCase()));
  const fromJd: string[] = [];

  const takeJdTerms = (list: string[] | undefined, weight: 2 | 3) => {
    for (const raw of list || []) {
      const s = (raw || "").trim();
      if (!s) continue;
      const known = bySurface.get(s.toLowerCase());
      if (known) {
        // The JD named something the library already carries: promote its weight, since
        // this role asked for it explicitly.
        if (weight > known.weight) known.weight = weight;
        if (!fromJd.includes(known.term)) fromJd.push(known.term);
        continue;
      }
      if (!isSearchableEvidence(s)) continue;
      if (seen.has(s.toLowerCase())) continue;
      // CONTAINMENT DEDUPE. A JD often restates a term we already hold, wrapped in its
      // own words ("CPA" -> "CPA license", "ASC 740" -> "ASC 740 provision work"). The
      // longer form is strictly worse as a search term: it matches a subset of what the
      // short form matches, usually nobody, and it costs the same query slot. Keep the
      // short one. Word-boundary checked so "SALT" does not swallow "SALT compliance"
      // by accident of spelling.
      const lowS = s.toLowerCase();
      if ([...seen].some((k) => k.length < lowS.length && new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(lowS))) continue;
      seen.add(lowS);
      // JD-specific terms have no kind we can infer reliably, so they are filed as
      // "domain": the middle weighting, neither gate-keeping nor mere tool exposure.
      terms.push({ term: s, kind: "domain", weight });
      fromJd.push(s);
    }
  };
  // Must-haves first so a term appearing in both lists settles at the higher weight.
  takeJdTerms(icp.mustHave, 3);
  takeJdTerms(icp.niceToHave, 2);

  // DERIVED VOCABULARY (any industry). Added last and never allowed to override a term
  // the library or the JD already established: curation and the client's own words both
  // outrank a general model's guess about the same market.
  const derived: string[] = [];
  for (const t of opts.derived || []) {
    const k = t.term.toLowerCase();
    if (seen.has(k) || bySurface.has(k)) continue;
    seen.add(k);
    terms.push(t);
    derived.push(t.term);
  }

  // MEASURED YIELD. Curated and JD-stated terms are protected: a thin sample must not
  // retire vocabulary a human asserted. Everything derived has to survive real profiles.
  const protectedTerms = new Set<string>();
  for (const t of library) protectedTerms.add(t.term.toLowerCase());
  for (const t of fromJd) protectedTerms.add(t.toLowerCase());
  const ranked = applyTermStats(terms, (opts.stats as any) || {}, protectedTerms);

  const queryGroups = proofQueryGroups(ranked.queryTerms, opts.perGroup ?? 6, opts.maxGroups ?? 4);
  return {
    verticals,
    terms: ranked.terms,
    queryGroups,
    fromJd,
    derived: derived.length ? derived : undefined,
    dropped: ranked.dropped.length ? ranked.dropped : undefined,
  };
}
