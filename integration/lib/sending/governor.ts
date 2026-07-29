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

/** Quarantine before a governor-paused domain may auto-revive (rest + fresh
 *  reputation data), env-tunable in days. */
function reviveAfterMs(): number {
  const days = Number(process.env.SENDING_GOVERNOR_REVIVE_DAYS);
  return (Number.isFinite(days) && days >= 1 ? days : 7) * 86_400_000;
}

/**
 * Run the governor across a workspace. Pauses offending domains (+ their
 * mailboxes), and auto-revives GOVERNOR-paused domains once quarantine has
 * passed and reputation reads clean: the domain restarts with a FRESH metrics
 * window and its mailboxes come back as "warming" (the reduced ramp), never at
 * full volume. Operator-paused domains are never auto-revived. Idempotent.
 */
export async function runGovernor(workspaceId: string): Promise<Array<{ domain: string; reason: string; action?: "paused" | "revived" }>> {
  const actions: Array<{ domain: string; reason: string; action?: "paused" | "revived" }> = [];
  const domains = await allDomains(workspaceId);
  const mailboxes = await allMailboxes(workspaceId);
  for (const d of domains) {
    if (d.status === "paused") {
      // Auto-revive pass: only for pauses THIS governor tripped.
      if (!d.autoPaused) continue;
      const restedLongEnough = d.pausedAt ? Date.now() - Date.parse(d.pausedAt) >= reviveAfterMs() : false;
      const reputationClean = d.reputation?.tier !== "bad"
        && !(typeof d.reputation?.spamRatePct === "number" && d.reputation.spamRatePct > THRESHOLDS.spamRatePct);
      if (restedLongEnough && reputationClean) {
        // Fresh measurement window: the old cumulative bounce/complaint counts
        // belong to the incident; the re-ramped domain earns its own record and
        // re-pauses automatically if it trips the thresholds again.
        d.metrics = { sent: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, openedHuman: 0, since: new Date().toISOString() };
        d.status = "active";
        d.autoPaused = false;
        d.pausedReason = undefined;
        await saveDomain(d);
        for (const m of mailboxes.filter((x) => x.domainId === d.id && x.status === "paused" && (x.pausedReason || "").startsWith("domain paused:"))) {
          m.status = "warming";
          m.pausedReason = undefined;
          await saveMailbox(m);
        }
        actions.push({ domain: d.domain, reason: "quarantine passed, reputation clean; re-ramping as warming", action: "revived" });
      }
      continue;
    }
    const reason = evaluateDomain(d);
    if (reason) {
      d.status = "paused";
      d.pausedReason = reason;
      d.autoPaused = true;
      d.pausedAt = new Date().toISOString();
      await saveDomain(d);
      for (const m of mailboxes.filter((x) => x.domainId === d.id && x.status !== "paused")) {
        m.status = "paused";
        m.pausedReason = `domain paused: ${reason}`;
        await saveMailbox(m);
      }
      actions.push({ domain: d.domain, reason, action: "paused" });
    }
  }
  return actions;
}

/**
 * Public-blocklist auto-pause. A Spamhaus DBL/ZEN listing used to be display-only (health
 * capped at 40 + a delisting action) while sends kept flowing; a listed domain kept burning
 * reputation until a human noticed. Now a listing pauses the domain the same way a complaint
 * spike does — across BOTH send stores: the owned-MTA fleet (SendingDomain) and the recruiter
 * SMTP inbox pool (sender inboxes on that domain). Probes are cached 6h in dnsProbe and
 * best-effort (a refused DNSBL query never reads as listed), so this can flag a real listing
 * but never false-alarm a pause. Opt out with OUTREACH_BLOCKLIST_AUTOPAUSE=0.
 */
export async function runBlocklistGuard(workspaceId: string): Promise<Array<{ domain: string; reason: string }>> {
  if (["0", "false", "no", "off"].includes((process.env.OUTREACH_BLOCKLIST_AUTOPAUSE || "").toLowerCase())) return [];
  const actions: Array<{ domain: string; reason: string }> = [];
  try {
    const { probeDnsMany } = await import("./dnsProbe");
    const senders = await import("../senders/store");
    const domains = await allDomains(workspaceId);
    const mailboxes = await allMailboxes(workspaceId);
    const inboxes = await senders.listInboxes(workspaceId);

    const poolByDomain = new Map<string, string[]>();
    for (const m of inboxes) {
      if (m.status === "paused") continue;
      const d = (m.email.split("@")[1] || "").toLowerCase();
      if (d) poolByDomain.set(d, [...(poolByDomain.get(d) || []), m.id]);
    }
    const candidates = new Set<string>([
      ...domains.filter((d) => d.status !== "paused").map((d) => d.domain.toLowerCase()),
      ...poolByDomain.keys(),
    ]);
    if (!candidates.size) return [];

    const postures = await probeDnsMany([...candidates]);
    for (const [domain, posture] of postures) {
      if (!posture?.dnsbl?.listed) continue;
      const reason = `listed on ${posture.dnsbl.lists.join(", ") || "a public spam blocklist"}`;
      const rec = domains.find((d) => d.domain.toLowerCase() === domain && d.status !== "paused");
      if (rec) {
        rec.status = "paused";
        rec.pausedReason = reason;
        await saveDomain(rec);
        for (const m of mailboxes.filter((x) => x.domainId === rec.id && x.status !== "paused")) {
          m.status = "paused";
          m.pausedReason = `domain paused: ${reason}`;
          await saveMailbox(m);
        }
        actions.push({ domain, reason });
      }
      const ids = poolByDomain.get(domain) || [];
      if (ids.length) {
        await senders.setStatus(workspaceId, ids, "paused", reason);
        actions.push({ domain, reason: `${reason} (inbox pool: ${ids.length} paused)` });
      }
    }
  } catch { /* best-effort: a probe failure must never break the daily tick */ }
  return actions;
}

/** Ensure a domain has a metrics object, then mutate it. */
export function ensureMetrics(d: SendingDomain): DeliveryMetrics {
  if (!d.metrics) d.metrics = { sent: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, openedHuman: 0, since: new Date(0).toISOString() };
  if (d.metrics.openedHuman === undefined) d.metrics.openedHuman = 0; // back-fill older snapshots
  return d.metrics;
}
