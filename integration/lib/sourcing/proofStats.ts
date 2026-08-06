/**
 * RecruitersOS · JD Sourcing · PROOF STATS: letting real runs decide which evidence works.
 *
 * WHY THIS EXISTS. Once vocabulary is generated rather than hand-written (proofExtract.ts),
 * something has to tell the difference between a term that describes the market and a term
 * the model made up because it sounded plausible. Opinion cannot do that at the scale of
 * every industry an agency might enter. Measurement can, and the measurement is free: we
 * already fetch thousands of profiles per run, so we can simply look at how often each
 * term actually appears on them.
 *
 * THE ONE SUBTLETY THAT MAKES THIS HONEST. A term used in a query FORCES itself to appear
 * in that query's results. Scoring its yield against those rows would be circular and
 * every term would look excellent. So yield is measured ONLY on rows found by the broad
 * (title and geo) searches, which are an unbiased sample of the population this role draws
 * from. Rows from the precision queries are counted for nothing.
 *
 * WHAT THE NUMBERS MEAN. Yield is the share of unbiased profiles carrying the term:
 *   ~0% over a large sample  = not real vocabulary for this market. Drop it. This is the
 *                              hallucination catch, and it is deliberately the only rule
 *                              that removes a term outright.
 *   low but non-zero         = a precise, discriminating filter. Exactly what we want in
 *                              a query, and emphatically NOT to be suppressed for rarity:
 *                              a rare credential is the best filter there is.
 *   very high                = everyone has it, so it separates nobody. Still worth points
 *                              when scoring, but it wastes a slot in the query matrix.
 *
 * Stats are kept per workspace AND per role signature, because the same word carries
 * different weight in different markets: "Epic" is near-universal for hospital nurses and
 * genuinely distinguishing for a medical device sales rep.
 *
 * Snapshot `sourcing_proof_stats_v1`. Tested by scripts/test-sourcing-proofstats.mts.
 */

import { loadSnapshot, debouncedSaver } from "../db";
import { nowIso } from "../core/ids";
import type { CandidateRow } from "./types";
import { type ProofTerm, matchProofTerms } from "./proofTerms";

const KEY = "sourcing_proof_stats_v1";

/** Unbiased rows a term must be measured against before its yield is trusted at all. */
export const MIN_SAMPLE = 400;
/** At or below this yield, over MIN_SAMPLE rows, a term is treated as not real for this
 *  market. Not zero: one accidental match should not rescue a hallucinated term. */
export const DEAD_YIELD = 0.002;
/** Above this yield a term stops discriminating and is dropped from the QUERY matrix
 *  (it keeps scoring, where a universal term is harmless). */
export const SATURATED_YIELD = 0.55;

export interface TermStat {
  /** Unbiased rows examined while this term was in the vocabulary. */
  seen: number;
  /** Unbiased rows that carried it. */
  hits: number;
  updatedAt: string;
}

type StatBlob = Record<string, Record<string, TermStat>>; // `${ws}::${roleSig}` -> term -> stat

let store: StatBlob = {};
let hydrated = false;
const save = debouncedSaver(KEY, () => store);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  const snap = await loadSnapshot<StatBlob>(KEY);
  if (snap && typeof snap === "object") store = snap;
  hydrated = true;
}

const bucketKey = (workspaceId: string, roleSig: string) => `${workspaceId}::${roleSig}`;

/** Rows found by the precision pass are excluded: their evidence was guaranteed by the
 *  query that found them, so counting them would measure our own boolean, not the market. */
export function isUnbiasedRow(row: CandidateRow): boolean {
  return !String(row.sourceGroup || "").startsWith("qualified:");
}

/**
 * Fold one run's results into the yield ledger.
 *
 * Pure counting, no judgement: interpretation happens in applyTermStats. Safe to call on
 * every run; a run with no unbiased rows simply records nothing.
 */
export async function recordTermYield(
  workspaceId: string,
  roleSig: string,
  terms: ProofTerm[],
  rows: CandidateRow[],
): Promise<{ sampled: number }> {
  if (!terms.length || !rows.length) return { sampled: 0 };
  await hydrate();
  const sample = rows.filter(isUnbiasedRow);
  if (!sample.length) return { sampled: 0 };

  const k = bucketKey(workspaceId, roleSig);
  const bucket = (store[k] = store[k] || {});
  const now = nowIso();

  // Count distinct rows carrying each term. matchProofTerms already returns one hit per
  // canonical term, so a profile repeating an alias cannot inflate the count.
  const hits = new Map<string, number>();
  for (const row of sample) {
    const text = [row.title, row.headline, row.company, row.snippet].filter(Boolean).join(" · ");
    if (!text.trim()) continue;
    for (const h of matchProofTerms(text, terms)) {
      hits.set(h.term, (hits.get(h.term) ?? 0) + 1);
    }
  }
  for (const t of terms) {
    const s = (bucket[t.term] = bucket[t.term] || { seen: 0, hits: 0, updatedAt: now });
    s.seen += sample.length;
    s.hits += hits.get(t.term) ?? 0;
    s.updatedAt = now;
  }
  save();
  return { sampled: sample.length };
}

export async function termStatsFor(workspaceId: string, roleSig: string): Promise<Record<string, TermStat>> {
  await hydrate();
  return store[bucketKey(workspaceId, roleSig)] || {};
}

export interface RankedTerms {
  /** Everything still worth scoring on, strongest first. */
  terms: ProofTerm[];
  /** The subset worth spending a query slot on (saturated terms removed). */
  queryTerms: ProofTerm[];
  /** Terms measured as absent from this market, for the "why did that disappear" answer. */
  dropped: string[];
}

/**
 * Apply measured yield to a vocabulary. Pure, so the suite can pin every rule.
 *
 * Curated library terms are never dropped: they were written by someone who knows the
 * vertical, and a thin sample must not be allowed to overrule them. Everything generated
 * is provisional and has to survive contact with real profiles.
 */
export function applyTermStats(
  terms: ProofTerm[],
  stats: Record<string, TermStat>,
  protectedTerms: Set<string> = new Set(),
): RankedTerms {
  const dropped: string[] = [];
  const kept: ProofTerm[] = [];
  const queryable: ProofTerm[] = [];

  for (const t of terms) {
    const s = stats[t.term];
    const measured = s && s.seen >= MIN_SAMPLE;
    const yieldRate = measured ? s.hits / Math.max(1, s.seen) : null;
    const isProtected = protectedTerms.has(t.term.toLowerCase());

    if (measured && yieldRate !== null && yieldRate <= DEAD_YIELD && !isProtected) {
      dropped.push(t.term);
      continue;
    }
    kept.push(t);
    // A term everyone has cannot narrow a search, so it stays for scoring and leaves the
    // query matrix to something that actually filters.
    if (!(measured && yieldRate !== null && yieldRate >= SATURATED_YIELD)) queryable.push(t);
  }

  // Rank query terms by discriminating power: weight first (a licence still outranks a
  // tool), then rarity among the measured ones, since a rarer real term filters harder.
  const rank = (t: ProofTerm) => {
    const s = stats[t.term];
    const measured = s && s.seen >= MIN_SAMPLE;
    const y = measured ? s.hits / Math.max(1, s.seen) : 0.25; // unmeasured sits mid-pack
    return t.weight * 10 + (1 - Math.min(1, y)) * 3;
  };
  queryable.sort((a, b) => rank(b) - rank(a));
  kept.sort((a, b) => b.weight - a.weight);
  return { terms: kept, queryTerms: queryable, dropped };
}
