/**
 * RecruiterOS · JD Sourcing
 * Rule-based fit scoring of a discovered candidate against the ICP.
 *
 * Deliberately cheap and deterministic ($0, no model call) so we can score every one
 * of thousands of rows. The optional LLM re-score (top slice only) lives elsewhere; this
 * is the bulk ranker. Scores are 0..100 with a transparent reason list for the UI.
 *
 * Signals, by weight:
 *   title match (40) · target-company match (25) · geography (20) ·
 *   seniority/leadership (10) · industry/keyword (5).  Disqualifiers zero the row.
 */

import type { CandidateICP, CandidateRow } from "./types";

function hay(row: CandidateRow): string {
  return [row.title, row.headline, row.company, row.location].filter(Boolean).join(" · ").toLowerCase();
}

function anyHit(text: string, needles: string[]): string | null {
  for (const n of needles) {
    const t = n.trim().toLowerCase();
    if (t && text.includes(t)) return n;
  }
  return null;
}

const LEADERSHIP = ["vp", "vice president", "head of", "director", "rvp", "regional", "area", "chief", "svp"];

export function scoreCandidate(row: CandidateRow, icp: CandidateICP): { fitScore: number; fitReasons: string[] } {
  const text = hay(row);
  const titleText = (row.title || row.headline || "").toLowerCase();
  const reasons: string[] = [];

  // Hard disqualifiers zero the row immediately.
  const dq = anyHit(text, icp.disqualifiers);
  if (dq) return { fitScore: 0, fitReasons: [`Disqualified: matches "${dq}"`] };

  let score = 0;

  const titleHit = anyHit(titleText, icp.titles);
  if (titleHit) { score += 40; reasons.push(`Title matches "${titleHit}"`); }
  else if (anyHit(titleText, LEADERSHIP)) { score += 20; reasons.push("Leadership-level title"); }

  const companyHit = anyHit((row.company || "").toLowerCase(), icp.targetCompanies);
  if (companyHit) { score += 25; reasons.push(`At target company ${companyHit}`); }

  const geoHit = anyHit((row.location || "").toLowerCase(), icp.geos);
  if (geoHit) { score += 20; reasons.push(`In-target geo (${geoHit})`); }
  else if (icp.remoteOk && /remote/.test(text)) { score += 8; reasons.push("Remote (geo-flexible)"); }

  if (icp.managesTeam && anyHit(titleText, LEADERSHIP)) { score += 10; reasons.push("Manages a team"); }

  const indHit = anyHit(text, icp.industries) || anyHit(text, icp.mustHave);
  if (indHit) { score += 5; reasons.push(`Domain signal "${indHit}"`); }

  if (anyHit(text, icp.niceToHave)) { score += 3; reasons.push("Has a nice-to-have"); }

  return { fitScore: Math.max(0, Math.min(100, score)), fitReasons: reasons };
}
