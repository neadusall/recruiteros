/**
 * RecruiterOS · Signal Engine
 * ICP matching + signal scoring.
 *
 * This is the "Match → Score" stage of the product's Pull → Match → Score → Trigger
 * flow (see signals.html). Raw signals are noisy; this module turns them into a ranked
 * work-list by:
 *   1. Dropping anything that hits an ICP disqualifier (hard filter).
 *   2. Combining five transparent components into a 0..100 score:
 *        base          — signal strength from the registry
 *        fit           — how well the subject matches the ICP
 *        recency       — time-decay using the signal's half-life
 *        corroboration — boost when multiple sources agree
 *        urgency       — signal-specific time pressure (e.g. a WARN effective date)
 *   3. Flagging whether the score clears the ICP's auto-trigger threshold.
 *
 * Every component is returned in `SignalScore.components` so the UI can show "why this
 * ranked here", and `reasons[]` gives plain-language justifications.
 */

import type {
  Company,
  ICP,
  Signal,
  SignalScore,
  FundingStage,
} from "./types";
import { getDefinition } from "./registry";

/** Reference "now" is passed in so scoring stays deterministic and testable. */
export interface ScoreContext {
  now: string; // ISO
}

/* ------------------------------------------------------------------ */
/* Disqualifiers (hard filter)                                         */
/* ------------------------------------------------------------------ */

/** Returns a disqualifier reason string if the signal should be dropped, else null. */
export function disqualify(signal: Signal, icp: ICP): string | null {
  const dq = icp.disqualifiers;
  if (!dq) return null;
  const co = signal.company;
  const hay = `${signal.title} ${signal.detail}`.toLowerCase();

  if (dq.keywords?.some((k) => hay.includes(k.toLowerCase()))) {
    return `matched excluded keyword`;
  }
  if (co) {
    if (dq.industries && co.industry && dq.industries.includes(co.industry)) {
      return `industry "${co.industry}" excluded`;
    }
    if (dq.stages && co.stage && dq.stages.includes(co.stage)) {
      return `stage "${co.stage}" excluded`;
    }
    if (typeof co.headcount === "number") {
      if (typeof dq.maxHeadcount === "number" && co.headcount > dq.maxHeadcount) {
        return `headcount ${co.headcount} > max ${dq.maxHeadcount}`;
      }
      if (typeof dq.minHeadcount === "number" && co.headcount < dq.minHeadcount) {
        return `headcount ${co.headcount} < min ${dq.minHeadcount}`;
      }
    }
    if (dq.geos && co.hqLocation?.country && dq.geos.includes(co.hqLocation.country)) {
      return `geo "${co.hqLocation.country}" excluded`;
    }
  }
  // Signal type not in the ICP's interest list (when one is specified).
  if (icp.signalTypes?.length && !icp.signalTypes.includes(signal.type)) {
    return `signal type "${signal.type}" not tracked by this ICP`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Component: fit                                                      */
/* ------------------------------------------------------------------ */

/**
 * 0..1 measure of how well the signal's subject matches the ICP. Built from the
 * dimensions that are present — absent data neither helps nor hurts, so sparse signals
 * are not unfairly penalized. Each matched dimension contributes; the result is the
 * average over the dimensions we could actually evaluate.
 */
export function fitScore(signal: Signal, icp: ICP): { value: number; reasons: string[] } {
  const reasons: string[] = [];
  const parts: number[] = [];
  const co = signal.company;
  const person = signal.person;

  if (icp.industries?.length && co?.industry) {
    const hit = icp.industries.includes(co.industry);
    parts.push(hit ? 1 : 0);
    if (hit) reasons.push(`industry fit (${co.industry})`);
  }
  if (icp.headcountBands?.length && co?.headcountBand) {
    const hit = icp.headcountBands.includes(co.headcountBand);
    parts.push(hit ? 1 : 0);
    if (hit) reasons.push(`size fit (${co.headcountBand})`);
  }
  if (icp.stages?.length && co?.stage) {
    const hit = icp.stages.includes(co.stage);
    parts.push(hit ? 1 : 0);
    if (hit) reasons.push(`stage fit (${prettyStage(co.stage)})`);
  }
  if (icp.geos?.length) {
    const country = co?.hqLocation?.country ?? person?.location?.country;
    const remote = co?.hqLocation?.remote ?? person?.location?.remote;
    const hit = (country && icp.geos.includes(country)) || (icp.remoteOk && remote);
    parts.push(hit ? 1 : 0);
    if (hit) reasons.push(remote ? "remote-eligible" : `geo fit (${country})`);
  }
  if (icp.titles?.length && (person?.title || person?.headline)) {
    const t = `${person?.title ?? ""} ${person?.headline ?? ""}`.toLowerCase();
    const hit = icp.titles.some((want) => t.includes(want.toLowerCase()));
    parts.push(hit ? 1 : 0);
    if (hit) reasons.push("title fit");
  }
  if (icp.techStack?.length && co?.techStack?.length) {
    const overlap = co.techStack.filter((x) =>
      icp.techStack!.some((y) => y.toLowerCase() === x.toLowerCase()),
    );
    parts.push(overlap.length ? 1 : 0);
    if (overlap.length) reasons.push(`tech overlap (${overlap.slice(0, 2).join(", ")})`);
  }

  // No comparable dimensions → neutral 0.5 so we neither boost nor bury it.
  const value = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0.5;
  return { value, reasons };
}

/* ------------------------------------------------------------------ */
/* Component: recency (time decay)                                     */
/* ------------------------------------------------------------------ */

/**
 * Exponential decay on the signal's half-life. A signal at its half-life scores 0.5;
 * at two half-lives, 0.25. Uses `eventAt` (when it happened), not ingestion time.
 */
export function recencyScore(signal: Signal, ctx: ScoreContext): number {
  const def = getDefinition(signal.type);
  const ageHours = Math.max(
    0,
    (new Date(ctx.now).getTime() - new Date(signal.eventAt).getTime()) / 3_600_000,
  );
  return Math.pow(0.5, ageHours / def.halfLifeHours);
}

/* ------------------------------------------------------------------ */
/* Component: corroboration                                            */
/* ------------------------------------------------------------------ */

/**
 * Multiple independent sources agreeing on the same event is a strong confidence
 * boost. Diminishing returns: 1 source → 0, 2 → ~0.5, 3 → ~0.67, capped at 1.
 * Distinct *connectors* count, so two pages from the same connector don't inflate it.
 */
export function corroborationScore(signal: Signal): number {
  const distinct = new Set(signal.sources.map((s) => s.connector)).size;
  return distinct <= 1 ? 0 : 1 - 1 / distinct;
}

/* ------------------------------------------------------------------ */
/* Component: urgency (signal-specific time pressure)                  */
/* ------------------------------------------------------------------ */

/**
 * Some signals carry an explicit deadline that should raise priority as it approaches:
 * a WARN effective date, a contract end, a planned office-closure date. Returns 0..1,
 * peaking ~2 weeks out and tapering after the date passes (the people are gone/placed).
 */
export function urgencyScore(signal: Signal, ctx: ScoreContext): number {
  const ev = signal.evidence as Record<string, unknown>;
  const deadlineRaw =
    (ev.effectiveDate as string) ?? (ev.endsAt as string) ?? (ev.closeDate as string);
  if (!deadlineRaw) {
    // Bursty intent signals get a flat mild urgency.
    return signal.type === "hiring_velocity" || signal.type === "intent_surge" ? 0.6 : 0.3;
  }
  const days =
    (new Date(deadlineRaw).getTime() - new Date(ctx.now).getTime()) / 86_400_000;
  if (days < -14) return 0.1;             // well past, talent already placed
  if (days < 0) return 0.5;               // just passed, still some left
  if (days <= 14) return 1;               // the hot two-week window
  if (days <= 45) return 0.7;
  return 0.4;                             // known but distant
}

/* ------------------------------------------------------------------ */
/* Composite score                                                     */
/* ------------------------------------------------------------------ */

/** Relative weights of the five components. Tuned so fit and base dominate, with
 *  recency/urgency as strong modifiers and corroboration as a smaller confidence nudge. */
const COMPONENT_WEIGHTS = {
  base: 0.3,
  fit: 0.3,
  recency: 0.2,
  urgency: 0.15,
  corroboration: 0.05,
} as const;

/**
 * Score one signal against one ICP. Returns a disqualified score (value 0) when a hard
 * filter matches, otherwise a 0..100 composite with a full component breakdown.
 */
export function scoreSignal(signal: Signal, icp: ICP, ctx: ScoreContext): SignalScore {
  const blocked = disqualify(signal, icp);
  if (blocked) {
    return {
      value: 0,
      components: { base: 0, fit: 0, recency: 0, corroboration: 0, urgency: 0 },
      shouldTrigger: false,
      reasons: [],
      disqualifiedBy: blocked,
    };
  }

  const def = getDefinition(signal.type);
  const override = icp.weightOverrides?.[signal.type];
  const base = Math.min(1, def.baseWeight * (override ?? 1));
  const fit = fitScore(signal, icp);
  const recency = recencyScore(signal, ctx);
  const corroboration = corroborationScore(signal);
  const urgency = urgencyScore(signal, ctx);

  const composite =
    COMPONENT_WEIGHTS.base * base +
    COMPONENT_WEIGHTS.fit * fit.value +
    COMPONENT_WEIGHTS.recency * recency +
    COMPONENT_WEIGHTS.urgency * urgency +
    COMPONENT_WEIGHTS.corroboration * corroboration;

  const value = Math.round(composite * 100);
  const threshold = icp.autoTriggerThreshold ?? 75;

  const reasons: string[] = [def.label, ...fit.reasons];
  if (recency > 0.7) reasons.push("fresh");
  else if (recency < 0.25) reasons.push("aging");
  if (corroboration > 0) reasons.push(`${new Set(signal.sources.map((s) => s.connector)).size} sources agree`);
  if (urgency >= 1) reasons.push("time-critical window");

  return {
    value,
    components: { base, fit: fit.value, recency, corroboration, urgency },
    shouldTrigger: value >= threshold,
    reasons,
  };
}

/**
 * Score and rank a batch against one ICP, dropping disqualified signals and sorting by
 * descending value. This is the work-list the product surfaces in the Signals tab.
 */
export function rankSignals(signals: Signal[], icp: ICP, ctx: ScoreContext): Signal[] {
  return signals
    .map((s) => ({ ...s, status: "scored" as const, score: scoreSignal(s, icp, ctx) }))
    .filter((s) => !s.score.disqualifiedBy)
    .sort((a, b) => (b.score?.value ?? 0) - (a.score?.value ?? 0));
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function prettyStage(s: FundingStage): string {
  const map: Record<FundingStage, string> = {
    pre_seed: "Pre-seed", seed: "Seed", series_a: "Series A", series_b: "Series B",
    series_c: "Series C", series_d_plus: "Series D+", public: "Public",
    bootstrapped: "Bootstrapped", unknown: "Unknown stage",
  };
  return map[s];
}

/** Convenience for the headcount → band mapping used during entity resolution. */
export function headcountBand(n: number): Company["headcountBand"] {
  if (n <= 10) return "1-10";
  if (n <= 50) return "11-50";
  if (n <= 200) return "51-200";
  if (n <= 500) return "201-500";
  if (n <= 1000) return "501-1000";
  if (n <= 5000) return "1001-5000";
  return "5000+";
}
