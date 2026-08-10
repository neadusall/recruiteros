/**
 * RecruitersOS · JD Sourcing · the outreach quality bar.
 *
 * ONE definition of "qualified enough to contact", shared by every delivery path
 * (Candidates promote, OS Text push, the autoflow sweeper) so a list can never mean
 * one thing on screen and another in a campaign.
 *
 * WHY THIS EXISTS (measured 2026-08-07 across the desk's last 40 runs, 25,320 rows):
 * only 22.3% of delivered rows scored 70 or better, and 8,892 of them (35%) scored
 * under 40 — people the scorer itself had already reported as "no function match,
 * likely a different role family". Every one of those was emailed and texted, because
 * the search screen defaulted its Min fit box to 10 and the delivery path applied no
 * bar at all (promote defaulted minFit to 0; the OS Text builder never read fitScore).
 * Enrichment credits, sending reputation and recruiter attention all went to them.
 *
 * The bar is deliberately NOT a second opinion about who is good. It reuses the fit
 * score the row already carries. It only stops the rows the existing scorer already
 * judged unqualified from being contacted.
 *
 * WHAT IT IS NOT: a cap on the saved list. Everyone found stays on the list and stays
 * visible; the bar governs who gets CONTACTED. That split is the same one the radius
 * makes (`outOfArea` rows stay on the list and never ride the texting lane).
 */

import type { CandidateRow } from "./types";

/**
 * Default floor for contacting someone, on the scorer's 0-100 scale.
 *
 * 45 is where the scorer stops describing a person as the wrong role family. Working
 * the components: an exact function match (35) plus a seniority band within one (12)
 * clears at 47; a single partial function hit (14) with seniority on target (20) and
 * an in-area location (15) clears at 49. Someone with NO function match tops out at
 * 35 even when their seniority and geography are both perfect, so they fall below it.
 * That is exactly the line we want: right job family in, wrong job family out.
 *
 * It is also the value `runDiscovery` has always used as its own default, so this
 * makes the two ends of the pipeline agree instead of quietly disagreeing by 35 points.
 */
export const DEFAULT_DELIVER_MIN_FIT = 45;

/** The configured floor. Env override so it can be tuned without a deploy. */
export function deliverMinFit(): number {
  const raw = Number(process.env.SOURCING_DELIVER_MIN_FIT);
  if (!Number.isFinite(raw)) return DEFAULT_DELIVER_MIN_FIT;
  // Clamped to the scale: a stray 900 would silence every list, a negative would
  // read as "off" when the operator meant "lowest".
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * Is this person qualified enough to contact?
 *
 * A row with NO fitScore at all is KEPT. Scoreless rows come from paths that never ran
 * the rule scorer (a Sales Nav URL import, a contact-database sweep), and an absent
 * score is not evidence of a bad match — treating it as one would silently delete whole
 * import routes from the outreach lane. Only a row that was scored AND scored below the
 * bar is held back.
 */
export function qualifiedForOutreach(row: CandidateRow, minFit: number): boolean {
  if (minFit <= 0) return true;
  const s = row.fitScore;
  if (typeof s !== "number" || !Number.isFinite(s)) return true;
  return s >= minFit;
}

export interface QualityBarResult {
  /** Rows clear to contact. */
  kept: CandidateRow[];
  /** Rows the bar held back (scored, and scored below it). */
  heldBack: CandidateRow[];
  /** The bar actually applied, so a caller can report the number it used. */
  bar: number;
}

/**
 * Split a run's rows into "contact these" and "held back".
 *
 * No never-empty fallback on purpose. The never-empty mandate is about a search never
 * coming back with nobody ON IT, and `rescueEmptyRun` already guarantees that upstream
 * at discovery time. This bar answers a different question, and when the honest answer
 * is "nobody found here is qualified", shipping a filler batch into a live campaign
 * would be the wrong kind of help. The caller reports the held-back count so the
 * recruiter can widen the search or lower the bar deliberately.
 */
export function applyQualityBar(rows: CandidateRow[], minFit = deliverMinFit()): QualityBarResult {
  const bar = Math.max(0, Math.min(100, Math.round(minFit)));
  const kept: CandidateRow[] = [];
  const heldBack: CandidateRow[] = [];
  for (const r of rows) (qualifiedForOutreach(r, bar) ? kept : heldBack).push(r);
  return { kept, heldBack, bar };
}

/**
 * Plain-English note for the run card. No score jargon: a recruiter reads outcomes,
 * not the internals of the ranker (see the hide-search-internals rule).
 */
export function qualityBarNote(heldBack: number, bar: number): string | undefined {
  if (heldBack <= 0) return undefined;
  return `${heldBack} ${heldBack === 1 ? "person" : "people"} on this list were not a close enough match to the role, so they were left out of the outreach. They are still on the list to look at. Lower "Min fit" in Advanced controls (currently ${bar}) if you want them contacted too.`;
}
