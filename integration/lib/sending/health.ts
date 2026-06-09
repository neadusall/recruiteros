/**
 * RecruiterOS · Deliverability scoring
 * Turns the raw sending state (mailbox warm-up progress + domain delivery
 * metrics + reputation + inbox-placement seed tests) into the two numbers the
 * UI shows: a per-mailbox WARMTH score and a per-domain HEALTH score, plus a
 * workspace roll-up. Pure functions over existing data — no fetches, no I/O —
 * so it is cheap to call on every dashboard render and trivial to unit-test.
 *
 * These scores are also the human-readable face of the fail-safes: a domain the
 * governor paused reports health ~15 with the reason, and any metric crossing a
 * governor threshold shows as a warning BEFORE the pause trips.
 */

import type { SendingDomain, Mailbox, SeedTest, DomainStatus } from "./types";
import { THRESHOLDS } from "./governor";

/** Steady-state daily ceiling a mailbox warms up to (mirrors warmup.ts). */
const CEILING = Number(process.env.SENDING_MAILBOX_CEILING || 50);
/** A domain needs this many sends before metric-based health is trusted. */
const MIN_VOLUME = 50;

function pct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}
function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}
function round(n: number): number {
  return Math.round(n);
}

/* ------------------------------------------------------------------ */
/* Mailbox warmth                                                      */
/* ------------------------------------------------------------------ */

export type WarmthLabel = "cold" | "warming" | "warm" | "paused";

export interface MailboxHealth {
  id: string;
  address: string;
  domainId: string;
  status: Mailbox["status"];
  /** 0-100: how far this mailbox has ramped toward its steady sending ceiling. */
  warmthScore: number;
  warmthLabel: WarmthLabel;
  warmupDay: number;
  dailyCap: number;
  ceiling: number;
  sentToday: number;
  /** Remaining sends in today's cap (the capacity the pool can still use). */
  capRemaining: number;
  paused: boolean;
  pausedReason?: string;
}

export function mailboxHealth(m: Mailbox): MailboxHealth {
  // Warmth is the ramp fraction toward the steady ceiling; an active (graduated)
  // mailbox is fully warm. A paused mailbox keeps its earned ramp but is flagged.
  const ramp = clamp((m.dailyCap / CEILING) * 100);
  const warmthScore = m.status === "active" ? 100 : round(ramp);
  const warmthLabel: WarmthLabel =
    m.status === "paused" ? "paused"
    : m.status === "active" ? "warm"
    : m.warmupDay <= 1 ? "cold"
    : "warming";
  return {
    id: m.id,
    address: m.address,
    domainId: m.domainId,
    status: m.status,
    warmthScore,
    warmthLabel,
    warmupDay: m.warmupDay,
    dailyCap: m.dailyCap,
    ceiling: CEILING,
    sentToday: m.sentToday,
    capRemaining: Math.max(0, m.dailyCap - m.sentToday),
    paused: m.status === "paused",
    pausedReason: m.pausedReason,
  };
}

/* ------------------------------------------------------------------ */
/* Domain health                                                       */
/* ------------------------------------------------------------------ */

export type HealthLabel = "healthy" | "watch" | "at_risk" | "paused" | "new";

export interface DomainHealthScore {
  id: string;
  domain: string;
  status: DomainStatus;
  /** 0-100 composite of delivery metrics + reputation + inbox placement. */
  healthScore: number;
  healthLabel: HealthLabel;
  sent: number;
  bounceRatePct: number;
  complaintRatePct: number;
  deliveryRatePct: number;
  reputationTier?: string;
  spamRatePct?: number;
  authPct?: number;
  /** Latest inbox-placement result (% of seeds in inbox/promotions), if tested. */
  inboxRatePct?: number;
  paused: boolean;
  pausedReason?: string;
  /** Human warnings — thresholds approached or crossed (the early-warning surface). */
  warnings: string[];
}

export function domainHealth(d: SendingDomain, latestSeed?: SeedTest): DomainHealthScore {
  const m = d.metrics;
  const sent = m?.sent ?? 0;
  const bounceRatePct = m ? pct(m.bounced, m.sent) : 0;
  const complaintRatePct = m ? pct(m.complained, m.sent) : 0;
  const deliveryRatePct = m ? pct(m.delivered, m.sent) : 0;
  const inboxRatePct = latestSeed?.status === "complete" ? latestSeed.inboxRatePct : undefined;
  const warnings: string[] = [];

  const base = {
    id: d.id, domain: d.domain, status: d.status, sent,
    bounceRatePct: round(bounceRatePct * 10) / 10,
    complaintRatePct: round(complaintRatePct * 100) / 100,
    deliveryRatePct: round(deliveryRatePct),
    reputationTier: d.reputation?.tier,
    spamRatePct: d.reputation?.spamRatePct,
    authPct: d.reputation?.authPct,
    inboxRatePct,
    pausedReason: d.pausedReason,
  };

  // Governor already pulled it: health is low and the reason is the headline.
  if (d.status === "paused") {
    return { ...base, healthScore: 15, healthLabel: "paused", paused: true, warnings: [d.pausedReason ?? "paused by governor"] };
  }

  const bounceCeil = THRESHOLDS.bounceRate * 100;       // 2%
  const complaintCeil = THRESHOLDS.complaintRate * 100; // 0.1%
  let score = 100;

  // Metric penalties only count once there is enough volume to be meaningful.
  if (sent >= MIN_VOLUME) {
    if (bounceRatePct > bounceCeil) { score -= 40; warnings.push(`bounce ${bounceRatePct.toFixed(1)}% over ${bounceCeil}%`); }
    else if (bounceRatePct > bounceCeil * 0.6) { score -= 15; warnings.push(`bounce ${bounceRatePct.toFixed(1)}% approaching limit`); }

    if (complaintRatePct > complaintCeil) { score -= 45; warnings.push(`complaints ${complaintRatePct.toFixed(2)}% over ${complaintCeil}%`); }
    else if (complaintRatePct > complaintCeil * 0.6) { score -= 20; warnings.push(`complaints ${complaintRatePct.toFixed(2)}% approaching limit`); }

    if (deliveryRatePct > 0 && deliveryRatePct < 95) { score -= round((95 - deliveryRatePct) / 2); }
  }

  // Reputation (works even at low volume).
  switch (d.reputation?.tier) {
    case "bad": score -= 45; warnings.push("reputation: bad"); break;
    case "low": score -= 20; warnings.push("reputation: low"); break;
    case "medium": score -= 8; break;
    default: break; // high / unknown
  }
  if (typeof d.reputation?.spamRatePct === "number" && d.reputation.spamRatePct > THRESHOLDS.spamRatePct) {
    score -= 30; warnings.push(`spam rate ${d.reputation.spamRatePct.toFixed(2)}% over ${THRESHOLDS.spamRatePct}%`);
  }
  if (typeof d.reputation?.authPct === "number" && d.reputation.authPct < 98) {
    score -= round((98 - d.reputation.authPct) / 2); warnings.push(`auth ${d.reputation.authPct}% (SPF/DKIM/DMARC)`);
  }

  // Inbox placement is the ground truth: blend it in heavily when measured.
  if (typeof inboxRatePct === "number") {
    score = round(score * 0.55 + inboxRatePct * 0.45);
    if (inboxRatePct < 80) warnings.push(`inbox placement ${inboxRatePct}%`);
  }

  score = clamp(score);

  // Brand-new / not-yet-active domains are "new", not judged on thin data.
  const tooNew = sent < MIN_VOLUME && typeof inboxRatePct !== "number";
  const healthLabel: HealthLabel =
    tooNew && d.status !== "active" ? "new"
    : score >= 80 ? "healthy"
    : score >= 55 ? "watch"
    : "at_risk";

  return { ...base, healthScore: score, healthLabel, paused: false, warnings };
}

/* ------------------------------------------------------------------ */
/* Workspace roll-up                                                   */
/* ------------------------------------------------------------------ */

export interface SendingHealthSummary {
  domains: DomainHealthScore[];
  mailboxes: MailboxHealth[];
  overall: {
    /** Send-weighted average domain health (0-100). */
    healthScore: number;
    /** Average mailbox warmth (0-100). */
    warmthScore: number;
    /** True when at least one active mailbox has capacity to send right now. */
    canSend: boolean;
    domains: number;
    mailboxes: number;
    activeMailboxes: number;
    warmingMailboxes: number;
    pausedDomains: number;
    atRiskDomains: number;
    /** Remaining sends across the whole pool today. */
    capacityToday: number;
    label: HealthLabel;
  };
}

/** Pick the most recent completed seed test per domain. */
function latestSeedByDomain(tests: SeedTest[]): Map<string, SeedTest> {
  const out = new Map<string, SeedTest>();
  for (const t of tests) {
    const cur = out.get(t.domainId);
    if (!cur || t.at > cur.at) out.set(t.domainId, t);
  }
  return out;
}

export function sendingHealth(domains: SendingDomain[], mailboxes: Mailbox[], seedTests: SeedTest[] = []): SendingHealthSummary {
  const seeds = latestSeedByDomain(seedTests);
  const domainScores = domains.map((d) => domainHealth(d, seeds.get(d.id)));
  const mailboxScores = mailboxes.map(mailboxHealth);

  // Send-weighted health (busy domains matter more); fall back to a flat mean.
  const totalSent = domainScores.reduce((s, d) => s + d.sent, 0);
  const healthScore = domainScores.length === 0 ? 0
    : totalSent > 0
      ? round(domainScores.reduce((s, d) => s + d.healthScore * d.sent, 0) / totalSent)
      : round(domainScores.reduce((s, d) => s + d.healthScore, 0) / domainScores.length);

  const warmthScore = mailboxScores.length === 0 ? 0
    : round(mailboxScores.reduce((s, m) => s + m.warmthScore, 0) / mailboxScores.length);

  const activeMailboxes = mailboxScores.filter((m) => m.status === "active").length;
  const warmingMailboxes = mailboxScores.filter((m) => m.status === "warming").length;
  const capacityToday = mailboxScores.filter((m) => !m.paused).reduce((s, m) => s + m.capRemaining, 0);
  const canSend = mailboxScores.some((m) => !m.paused && m.capRemaining > 0);
  const pausedDomains = domainScores.filter((d) => d.paused).length;
  const atRiskDomains = domainScores.filter((d) => d.healthLabel === "at_risk").length;

  const label: HealthLabel =
    pausedDomains > 0 || atRiskDomains > 0 ? "at_risk"
    : healthScore >= 80 ? "healthy"
    : healthScore >= 55 ? "watch"
    : domainScores.length === 0 ? "new"
    : "watch";

  return {
    domains: domainScores,
    mailboxes: mailboxScores,
    overall: {
      healthScore, warmthScore, canSend,
      domains: domainScores.length,
      mailboxes: mailboxScores.length,
      activeMailboxes, warmingMailboxes,
      pausedDomains, atRiskDomains,
      capacityToday,
      label,
    },
  };
}
