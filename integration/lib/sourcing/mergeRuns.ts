/**
 * RecruitersOS · JD Sourcing
 * Pure merge of several saved sourcing runs into one deduped candidate set —
 * the engine behind the "Combine lists" button.
 *
 * Rules (stability-critical: regression-tested in scripts/test-sourcing-merge.mts):
 * - Dedupe by the same stable person key used everywhere (LinkedIn URL
 *   lowercased/trailing-slash-stripped, else name|company).
 * - On a collision the STRONGER row wins: verified (deep-vet) score first,
 *   then rule fit score.
 * - Fill-blanks field merge: an email found on one list and a phone found on
 *   another BOTH survive onto the winning row. Nothing is overwritten.
 * - A deep-vet verdict earned on either list carries over whole (never mixed
 *   field-by-field across two different vets).
 * - Result is re-ranked verified-first (same ordering the tab shows).
 */

import type { CandidateRow, SourcingRun } from "./types";

/** Stable per-candidate key: LinkedIn URL when present, else name+company. */
function mergeKey(c: CandidateRow): string {
  return (c.linkedinUrl || `${c.fullName}|${c.company ?? ""}`).toLowerCase().replace(/\/+$/, "");
}

/**
 * Verified-first ranking, with the location split preserved ahead of everything.
 *
 * A merge can fold a tightly geo'd list into a loose or nationwide one. Ranking purely
 * by score then let an out-of-area person outrank a local on the COMBINED list, which is
 * the one that auto-promotes to Candidates and OS Text — so the radius the recruiter set
 * on one search silently stopped applying once they combined it. In-area first mirrors
 * what runDiscovery and rerank already guarantee for a single run.
 */
function rankByVerdict(rows: CandidateRow[]): void {
  rows.sort((a, c) =>
    Number(Boolean(a.outOfArea)) - Number(Boolean(c.outOfArea)) ||
    (c.verifiedScore ?? -1) - (a.verifiedScore ?? -1) ||
    c.fitScore - a.fitScore);
}

const FILL_FIELDS = [
  "email", "linkedinUrl", "title", "headline", "company",
  "location", "imageUrl", "provider", "sourceGroup",
] as const;

export interface MergedRuns {
  /** Deduped, verified-first-ranked union of every source run's candidates. */
  candidates: CandidateRow[];
  /** How many duplicate rows were folded into a survivor. */
  overlap: number;
  /** The largest source run — anchors the combined run's name/JD/ICP. */
  anchor: SourcingRun;
}

export function mergeSourcingRuns(runs: SourcingRun[]): MergedRuns {
  if (!runs.length) throw new Error("mergeSourcingRuns: no runs given");
  const anchor = runs.reduce((a, r) => (r.candidates.length > a.candidates.length ? r : a), runs[0]);
  const strength = (row: CandidateRow) => (row.verifiedScore ?? -1) * 1000 + row.fitScore;
  const byKey = new Map<string, CandidateRow>();
  let overlap = 0;
  for (const r of runs) {
    for (const c of r.candidates) {
      const k = mergeKey(c);
      const prev = byKey.get(k);
      if (!prev) { byKey.set(k, { ...c }); continue; }
      overlap++;
      const keep = strength(c) > strength(prev) ? { ...c } : prev;
      const other = keep === prev ? c : prev;
      // Fill-blanks field merge: contact + identity data found on either list survives.
      for (const f of FILL_FIELDS) {
        if (!keep[f] && other[f]) keep[f] = other[f];
      }
      // Phone + its provenance move as a PAIR: taking one row's number with the other
      // row's source label would corrupt the phone-accuracy metric.
      if (!keep.phone && other.phone) { keep.phone = other.phone; keep.phoneSource = other.phoneSource; }
      if (keep.llmScore == null && other.llmScore != null) keep.llmScore = other.llmScore;
      // Location verdict is a MEASUREMENT, not a preference, so it must not be decided by
      // whichever row happened to score higher. If either list placed this person inside
      // its target area, they are genuinely local to that search; keep the nearer reading.
      if (!other.outOfArea) keep.outOfArea = false;
      if (keep.milesFromTarget == null && other.milesFromTarget != null) {
        keep.milesFromTarget = other.milesFromTarget;
      } else if (other.milesFromTarget != null && keep.milesFromTarget != null) {
        keep.milesFromTarget = Math.min(keep.milesFromTarget, other.milesFromTarget);
      }
      // A deep-vet verdict earned on either list carries over whole (not field-mixed).
      if (keep.verifiedScore == null && other.verifiedScore != null) {
        keep.verifiedScore = other.verifiedScore; keep.verdict = other.verdict;
        keep.yearsRelevant = other.yearsRelevant; keep.vetStrengths = other.vetStrengths;
        keep.vetGaps = other.vetGaps; keep.vetFlags = other.vetFlags;
        keep.vetRationale = other.vetRationale; keep.profileFetched = other.profileFetched;
      }
      byKey.set(k, keep);
    }
  }
  const candidates = Array.from(byKey.values());
  rankByVerdict(candidates);
  return { candidates, overlap, anchor };
}
