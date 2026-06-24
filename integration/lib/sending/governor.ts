/**
 * RecruitersOS · Deliverability governor
 * The supervisor that pauses a mailbox/domain BEFORE it burns a pool. Evaluates
 * rolling metrics + reputation against hard thresholds and trips a pause with a
 * reason. Runs after every webhook update and on the daily tick.
 *
 * Thresholds (conservative; Google's user-reported spam ceiling is 0.3%):
 *   bounce rate    > 2%    -> pause (list hygiene / bad targets)
 *   complaint rate > 0.1%  -> pause (the #1 reputation killer)
 *   reputation tier 'bad'  -> pause
 *   spam rate      > 0.3%  -> pause
 */

import { allDomains, allMailboxes, saveDomain, saveMailbox } from "./store";
import type { SendingDomain, DeliveryMetrics } from "./types";

export const THRESHOLDS = { bounceRate: 0.02, complaintRate: 0.001, spamRatePct: 0.3 };

function rate(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

/** Evaluate one domain; returns a pause reason or null. */
export function evaluateDomain(d: SendingDomain): string | null {
  const m: DeliveryMetrics | undefined = d.metrics;
  if (m && m.sent >= 50) {
    const b = rate(m.bounced, m.sent);
    const c = rate(m.complained, m.sent);
    if (b > THRESHOLDS.bounceRate) return `bounce rate ${(b * 100).toFixed(1)}% > ${(THRESHOLDS.bounceRate * 100)}%`;
    if (c > THRESHOLDS.complaintRate) return `complaint rate ${(c * 100).toFixed(2)}% > ${(THRESHOLDS.complaintRate * 100)}%`;
  }
  const r = d.reputation;
  if (r?.tier === "bad") return "reputation tier: bad";
  if (typeof r?.spamRatePct === "number" && r.spamRatePct > THRESHOLDS.spamRatePct) {
    return `spam rate ${r.spamRatePct.toFixed(2)}% > ${THRESHOLDS.spamRatePct}%`;
  }
  return null;
}

/**
 * Run the governor across a workspace. Pauses offending domains (+ their
 * mailboxes) and returns what it did. Idempotent.
 */
export async function runGovernor(workspaceId: string): Promise<Array<{ domain: string; reason: string }>> {
  const actions: Array<{ domain: string; reason: string }> = [];
  const domains = await allDomains(workspaceId);
  const mailboxes = await allMailboxes(workspaceId);
  for (const d of domains) {
    if (d.status === "paused") continue;
    const reason = evaluateDomain(d);
    if (reason) {
      d.status = "paused";
      d.pausedReason = reason;
      await saveDomain(d);
      for (const m of mailboxes.filter((x) => x.domainId === d.id && x.status !== "paused")) {
        m.status = "paused";
        m.pausedReason = `domain paused: ${reason}`;
        await saveMailbox(m);
      }
      actions.push({ domain: d.domain, reason });
    }
  }
  return actions;
}

/** Ensure a domain has a metrics object, then mutate it. */
export function ensureMetrics(d: SendingDomain): DeliveryMetrics {
  if (!d.metrics) d.metrics = { sent: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, openedHuman: 0, since: new Date(0).toISOString() };
  if (d.metrics.openedHuman === undefined) d.metrics.openedHuman = 0; // back-fill older snapshots
  return d.metrics;
}
