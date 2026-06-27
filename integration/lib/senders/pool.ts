/**
 * RecruitersOS · Senders · recruiter-scoped rotation
 * Pick the next inbox to send from for a given recruiter's pool: an active inbox
 * under its daily cap, most-remaining-capacity first, so sends spread evenly across
 * the recruiter's hundreds of Email IDs without burning any single one. Omit
 * recruiterId to rotate across the whole portal pool.
 */
import { listInboxes, recordSend } from "./store";
import { coldCap } from "./limits";
import type { SenderInbox } from "./types";

function sendable(m: SenderInbox): boolean {
  return (m.status === "active" || m.status === "warming") && m.sentToday < coldCap(m.dailyCap);
}

export interface PickOpts { recruiterId?: string; excludeIds?: string[]; }

/** Choose the best inbox to send from. Scoped to a recruiter when recruiterId is set. */
export async function pickSender(workspaceId: string, opts: PickOpts = {}): Promise<SenderInbox | null> {
  const exclude = new Set(opts.excludeIds || []);
  const pool = (await listInboxes(workspaceId, { ownerId: opts.recruiterId }))
    .filter((m) => sendable(m) && !exclude.has(m.id))
    .sort((a, b) => (coldCap(b.dailyCap) - b.sentToday) - (coldCap(a.dailyCap) - a.sentToday));
  return pool[0] || null;
}

/** Remaining send capacity today across a recruiter's pool. */
export async function poolCapacity(
  workspaceId: string,
  recruiterId?: string,
): Promise<{ inboxes: number; remainingToday: number; dailyCapacity: number }> {
  const pool = (await listInboxes(workspaceId, { ownerId: recruiterId })).filter(sendable);
  let rem = 0, cap = 0;
  for (const m of pool) { rem += Math.max(0, coldCap(m.dailyCap) - m.sentToday); cap += coldCap(m.dailyCap); }
  return { inboxes: pool.length, remainingToday: rem, dailyCapacity: cap };
}

export { recordSend };
