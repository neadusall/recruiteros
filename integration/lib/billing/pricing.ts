/**
 * RecruitersOS · Billing · Pricing engine (OWNER ONLY)
 *
 * Turns the cost-rate catalog into two answers the owner actually needs:
 *   1. "What does an account that sends N emails/month COST me?"  -> estimateCost
 *   2. "What should I CHARGE that account?"                        -> recommendPrice
 *
 * The cost build is fully itemized and auditable: every line shows the driver,
 * the quantity, the unit cost, and the subtotal, so the headline number is
 * never a black box. Pricing is anchored to a target gross margin (default 85%)
 * and then nudged to a clean published number.
 *
 * Recruiting OS and Business Development OS share one infrastructure, so the
 * COST is identical at a given volume. They differ only in willingness to pay:
 * a BD seat that lands a new client is worth more than a recruiting seat, so the
 * recommended price carries a per-motion multiplier.
 */

import type { Motion } from "../core/types";
import {
  DEFAULT_CONSTANTS,
  rateCost,
  type PricingConstants,
} from "./rates";

export interface CostLine {
  rateId: string;
  label: string;
  category: string;
  quantity: number;
  unit: string;
  unitCostUsd: number;
  subtotalUsd: number;
}

export interface CostBreakdown {
  emailsPerMonth: number;
  uniqueProspects: number;
  inboxes: number;
  domains: number;
  lines: CostLine[];
  totalCostUsd: number;
  /** Cost per email sent and per prospect, for quick gut-checks. */
  costPerEmailUsd: number;
  costPerProspectUsd: number;
}

export interface PriceRecommendation {
  motion: Motion;
  breakdown: CostBreakdown;
  targetGrossMargin: number;
  /** Raw price that hits the target margin exactly. */
  priceAtTargetUsd: number;
  /** Clean published number at or above the target. */
  recommendedPriceUsd: number;
  /** Margin actually achieved at the recommended (clean) price. */
  effectiveGrossMarginPct: number;
  /** Monthly gross profit at the recommended price. */
  monthlyGrossProfitUsd: number;
  /** Per-motion multiplier applied (recruiting = 1.0 baseline). */
  motionMultiplier: number;
}

export interface EstimateOptions {
  emailsPerMonth: number;
  /** Override the default sequence length (sends per prospect). */
  sequenceStepsPerProspect?: number;
  /** Pull mobile numbers (separate, expensive, low-yield on the cheap tier). */
  wantMobile?: boolean;
  /** Pull landline / direct-dial numbers (separate from mobile). */
  wantLandline?: boolean;
  /** Back-compat alias: pull BOTH mobile and landline. */
  wantPhone?: boolean;
  /** Run AI first-line personalization (default true). */
  aiPersonalize?: boolean;
  /** Runtime rate overrides (id -> unitCostUsd). */
  rateOverrides?: Record<string, number>;
  /** Runtime constant overrides. */
  constants?: Partial<PricingConstants>;
}

/** Per-motion willingness-to-pay multiplier on the recommended price. */
export const MOTION_MULTIPLIER: Record<Motion, number> = {
  recruiting: 1.0,
  bd: 1.3,
};

/** The three preset volumes the owner asked about. */
export const PRESET_VOLUMES = [5_000, 10_000, 20_000];

function k(constants?: Partial<PricingConstants>): PricingConstants {
  return { ...DEFAULT_CONSTANTS, ...(constants ?? {}) };
}

/**
 * Itemized monthly cost for an account at a given send volume. Pure and
 * deterministic — no clock, no network — so the console and the docs agree.
 */
export function estimateCost(opts: EstimateOptions): CostBreakdown {
  const c = k(opts.constants);
  const ov = opts.rateOverrides;
  const emails = Math.max(0, Math.round(opts.emailsPerMonth));
  const steps = opts.sequenceStepsPerProspect ?? c.sequenceStepsPerProspect;
  const prospects = steps > 0 ? Math.ceil(emails / steps) : emails;
  const inboxes = Math.ceil(emails / c.sendsPerInboxMonth) || 0;
  const domains = Math.ceil(inboxes / c.inboxesPerDomain) || 0;
  const replies = Math.round(prospects * c.replyRate);

  const lines: CostLine[] = [];
  const add = (rateId: string, label: string, category: string, quantity: number, unit: string) => {
    const unitCostUsd = rateCost(rateId, ov);
    lines.push({
      rateId,
      label,
      category,
      quantity,
      unit,
      unitCostUsd,
      subtotalUsd: round(quantity * unitCostUsd),
    });
  };

  // Enrichment — per unique prospect.
  add("email_find", "Email find (waterfall)", "enrichment", prospects, "emails");
  add("email_verify", "Email verification", "enrichment", prospects, "emails");
  // Phone is split into separate mobile + landline fields, each opt-in.
  const wantMobile = opts.wantMobile ?? opts.wantPhone ?? false;
  const wantLandline = opts.wantLandline ?? opts.wantPhone ?? false;
  if (wantMobile) add("mobile_find", "Mobile phone find", "enrichment", prospects, "mobiles");
  if (wantLandline) add("landline_find", "Landline / direct-dial find", "enrichment", prospects, "landlines");

  // AI — first-touch personalization per prospect + reply handling.
  if (opts.aiPersonalize !== false) {
    add("ai_personalize", "AI personalization", "ai", prospects, "prospects");
  }
  add("ai_classify_reply", "AI reply classification", "ai", replies, "replies");

  // Sending capacity — inboxes + domains.
  add("inbox_month", "Mailboxes", "sending", inboxes, "inboxes");
  add("domain_month", "Sending domains", "sending", domains, "domains");

  // Signals — free, shown for completeness ($0).
  add("signals_free", "Hiring/intent signals", "signals", prospects, "signals");

  // Infra — one allocation per active account.
  add("platform_account_month", "Platform infra (allocated)", "infra", 1, "account");

  const totalCostUsd = round(lines.reduce((s, l) => s + l.subtotalUsd, 0));
  return {
    emailsPerMonth: emails,
    uniqueProspects: prospects,
    inboxes,
    domains,
    lines,
    totalCostUsd,
    costPerEmailUsd: emails ? round(totalCostUsd / emails, 4) : 0,
    costPerProspectUsd: prospects ? round(totalCostUsd / prospects, 4) : 0,
  };
}

/**
 * Recommend a monthly price from a cost breakdown: hit the target margin, apply
 * the motion multiplier, then round up to a clean published number.
 */
export function recommendPrice(
  breakdown: CostBreakdown,
  motion: Motion,
  opts?: { targetGrossMargin?: number; constants?: Partial<PricingConstants> },
): PriceRecommendation {
  const c = k(opts?.constants);
  const margin = opts?.targetGrossMargin ?? c.targetGrossMargin;
  const mult = MOTION_MULTIPLIER[motion] ?? 1;

  const priceAtTarget = margin < 1 ? breakdown.totalCostUsd / (1 - margin) : breakdown.totalCostUsd;
  const recommended = cleanPrice(priceAtTarget * mult);
  const grossProfit = round(recommended - breakdown.totalCostUsd);
  const effMargin = recommended > 0 ? round((grossProfit / recommended) * 100, 1) : 0;

  return {
    motion,
    breakdown,
    targetGrossMargin: margin,
    priceAtTargetUsd: round(priceAtTarget),
    recommendedPriceUsd: recommended,
    effectiveGrossMarginPct: effMargin,
    monthlyGrossProfitUsd: grossProfit,
    motionMultiplier: mult,
  };
}

/** Build the full preset table (5k / 10k / 20k) for both motions. */
export function presetPricingTable(opts?: Omit<EstimateOptions, "emailsPerMonth"> & { targetGrossMargin?: number }) {
  const motions: Motion[] = ["recruiting", "bd"];
  return motions.map((motion) => ({
    motion,
    tiers: PRESET_VOLUMES.map((emailsPerMonth) => {
      const breakdown = estimateCost({ ...opts, emailsPerMonth });
      return recommendPrice(breakdown, motion, {
        targetGrossMargin: opts?.targetGrossMargin,
        constants: opts?.constants,
      });
    }),
  }));
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Round a raw price up to a clean, sellable number:
 *   < $200   -> next $10        (e.g. 143 -> 150)
 *   < $1,000 -> next $49 anchor (e.g. 539 -> 549, 286 -> 299)
 *   >= $1,000-> next $50        (e.g. 1027 -> 1050... nudged to 999/1299 anchors below)
 * Then snap to the nearest psychological anchor (…9) at or above.
 */
function cleanPrice(raw: number): number {
  if (raw <= 0) return 0;
  let base: number;
  if (raw < 200) base = Math.ceil(raw / 10) * 10 - 1;        // 149, 159, ...
  else if (raw < 1000) base = Math.ceil(raw / 50) * 50 - 1;  // 299, 349, 549, ...
  else base = Math.ceil(raw / 50) * 50 - 1;                  // 1049, 1299, ...
  return base;
}

function round(n: number, dp = 2): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}
