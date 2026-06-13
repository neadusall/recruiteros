/**
 * RecruitersOS · Caps + rotation
 * Per-mailbox daily caps with a warm-up ramp, and pool-aware mailbox selection:
 * pick the healthiest mailbox under its cap, on an active (verified, un-paused)
 * domain, spreading load so no single mailbox/domain burns.
 */

import { allMailboxes, allDomains, saveMailbox, getServer, saveServer } from "./store";
import type { Mailbox, SendingDomain, MtaServer } from "./types";

/**
 * Warm-up ramp: day 0 starts at 10/day and climbs ~+5/day to a steady ceiling.
 * Conservative on purpose — slow ramps protect reputation.
 */
export function capForDay(day: number, ceiling = 50): number {
  return Math.min(ceiling, 10 + day * 5);
}

/** Steady-state per-IP daily ceiling once the IP is fully warmed. */
const IP_CEILING = Number(process.env.SENDING_IP_CEILING || 1000);

/**
 * IP/pool warm-up ramp: a shared IP starts at 50/day and climbs ~+50/day to its
 * ceiling (~1,000/day) over ~3 weeks. This is the long pole — a cold IPv4 must be
 * warmed gently or every mailbox on it suffers. Total daily sends across ALL
 * mailboxes on a server are gated by this, on top of the per-mailbox caps.
 */
export function serverCapForDay(day: number, ceiling = IP_CEILING): number {
  return Math.min(ceiling, 50 + day * 50);
}
export function serverDailyCap(s: MtaServer): number { return serverCapForDay(s.warmupDay ?? 0); }
export function serverHasCapacity(s: MtaServer): boolean { return (s.sentToday ?? 0) < serverDailyCap(s); }

/** Record a send against the server's shared-IP daily ceiling. */
export async function recordServerSend(workspaceId: string, serverId?: string): Promise<void> {
  if (!serverId) return;
  const s = await getServer(workspaceId, serverId);
  if (!s) return;
  s.sentToday = (s.sentToday ?? 0) + 1;
  s.sent = (s.sent ?? 0) + 1;
  await saveServer(s);
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

/** Reset daily counters (call once per day from the daily tick) — mailboxes AND IPs. */
export async function resetDaily(workspaceId: string): Promise<void> {
  for (const m of await allMailboxes(workspaceId)) {
    if (m.sentToday !== 0) { m.sentToday = 0; await saveMailbox(m); }
  }
  const { listServers } = await import("./store");
  for (const s of await listServers(workspaceId)) {
    if ((s.sentToday ?? 0) !== 0) { s.sentToday = 0; await saveServer(s); }
  }
}
