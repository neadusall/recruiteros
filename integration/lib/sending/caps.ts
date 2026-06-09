/**
 * RecruiterOS · Caps + rotation
 * Per-mailbox daily caps with a warm-up ramp, and pool-aware mailbox selection:
 * pick the healthiest mailbox under its cap, on an active (verified, un-paused)
 * domain, spreading load so no single mailbox/domain burns.
 */

import { allMailboxes, allDomains, saveMailbox } from "./store";
import type { Mailbox, SendingDomain } from "./types";

/**
 * Warm-up ramp: day 0 starts at 10/day and climbs ~+5/day to a steady ceiling.
 * Conservative on purpose — slow ramps protect reputation.
 */
export function capForDay(day: number, ceiling = 50): number {
  return Math.min(ceiling, 10 + day * 5);
}

/** A mailbox can send now if active/warming, not paused, and under its cap. */
function sendable(m: Mailbox): boolean {
  return m.status !== "paused" && m.sentToday < m.dailyCap;
}

/**
 * Pick the best mailbox to send from. Prefers a specific domain when given,
 * otherwise spreads across healthy domains. Returns the mailbox + its domain, or
 * null when nothing has remaining capacity.
 */
export async function pickMailbox(
  workspaceId: string,
  opts: { domainId?: string } = {},
): Promise<{ mailbox: Mailbox; domain: SendingDomain } | null> {
  const domains = (await allDomains(workspaceId)).filter((d) => d.status === "active" && !d.pausedReason);
  const byId = new Map(domains.map((d) => [d.id, d]));
  const mailboxes = (await allMailboxes(workspaceId))
    .filter((m) => byId.has(m.domainId) && sendable(m))
    .filter((m) => !opts.domainId || m.domainId === opts.domainId)
    // most remaining capacity first → even spread
    .sort((a, b) => (b.dailyCap - b.sentToday) - (a.dailyCap - a.sentToday));
  const m = mailboxes[0];
  if (!m) return null;
  return { mailbox: m, domain: byId.get(m.domainId) as SendingDomain };
}

/** Record a send against a mailbox (cap accounting + lifetime counter). */
export async function recordSend(m: Mailbox): Promise<void> {
  m.sentToday += 1;
  m.sent += 1;
  await saveMailbox(m);
}

/** Reset daily counters (call once per day from the daily tick). */
export async function resetDaily(workspaceId: string): Promise<void> {
  for (const m of await allMailboxes(workspaceId)) {
    if (m.sentToday !== 0) { m.sentToday = 0; await saveMailbox(m); }
  }
}
