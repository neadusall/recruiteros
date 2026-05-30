/**
 * RecruiterOS · Campaigns
 * A/B variant selection + the kill rule.
 *
 * Reference framework: ONE variable per campaign, 50/50 baseline, >= 200 sends
 * per variant before declaring a winner, run >= 7 days, kill the loser when the
 * reply-rate gap > 30% AND p < 0.05. Winner stays; next campaign re-tests.
 */

export interface Variant {
  id: string;
  label: string;            // "Direct Hook" | "Curiosity Hook" | ...
  weight: number;           // relative traffic weight
  /** Which single variable this campaign is testing. */
  variable: "subject" | "opener" | "cta" | "voice_note" | "send_time" | "case_study";
  sends: number;
  replies: number;
  enabled: boolean;
}

/** Weighted pick among enabled variants. Deterministic via a seed (0..1). */
export function pickVariant(variants: Variant[], seed: number): Variant | null {
  const live = variants.filter((v) => v.enabled);
  if (live.length === 0) return null;
  const total = live.reduce((s, v) => s + v.weight, 0);
  let r = (seed % 1) * total;
  for (const v of live) {
    if ((r -= v.weight) <= 0) return v;
  }
  return live[live.length - 1];
}

export interface AbVerdict {
  decided: boolean;
  winner?: string;
  loser?: string;
  gap: number;             // relative reply-rate gap
  pValue: number;
  reason: string;
}

const MIN_SENDS = 200;
const GAP_THRESHOLD = 0.3;
const P_THRESHOLD = 0.05;

/** Evaluate a 2-variant test against the kill rule. */
export function evaluate(a: Variant, b: Variant): AbVerdict {
  if (a.sends < MIN_SENDS || b.sends < MIN_SENDS) {
    return { decided: false, gap: 0, pValue: 1, reason: `need >= ${MIN_SENDS} sends per variant` };
  }
  const ra = a.replies / a.sends;
  const rb = b.replies / b.sends;
  const [hi, lo, hv, lv] = ra >= rb ? [ra, rb, a, b] : [rb, ra, b, a];
  const gap = lo === 0 ? 1 : (hi - lo) / lo;
  const p = twoProportionP(hv.replies, hv.sends, lv.replies, lv.sends);

  if (gap > GAP_THRESHOLD && p < P_THRESHOLD) {
    return { decided: true, winner: hv.label, loser: lv.label, gap, pValue: p, reason: "kill rule met: gap > 30% and p < 0.05" };
  }
  return { decided: false, winner: hv.label, gap, pValue: p, reason: "not significant yet" };
}

/** Two-proportion z-test -> two-sided p-value (normal approximation). */
function twoProportionP(x1: number, n1: number, x2: number, n2: number): number {
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  const z = Math.abs(p1 - p2) / se;
  return 2 * (1 - normalCdf(z));
}

function normalCdf(z: number): number {
  // Abramowitz-Stegun approximation of the standard normal CDF.
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return 1 - p;
}

/** What to test, in leverage order, for the campaign builder UI. */
export const TEST_LEVERS = [
  { variable: "subject", note: "Biggest lever on open rate." },
  { variable: "opener", note: "Direct signal-first vs Curiosity question-first." },
  { variable: "cta", note: "'15 min' vs 'thumbs up if interested' vs 'reply yes/no'." },
  { variable: "voice_note", note: "HOT-tier only; cost control." },
  { variable: "send_time", note: "Tue/Wed/Thu 8am vs 4pm." },
  { variable: "case_study", note: "Comparable Co A vs B." },
] as const;
