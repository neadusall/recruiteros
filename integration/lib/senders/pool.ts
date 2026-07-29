/**
 * RecruitersOS · Senders · recruiter-scoped rotation
 * Pick the next inbox to send from for a given recruiter's pool: an active inbox
 * under its daily cap, most-remaining-capacity first, so sends spread evenly across
 * the recruiter's hundreds of Email IDs without burning any single one. Omit
 * recruiterId to rotate across the whole portal pool.
 */
import { listInboxes, recordSend, resetDailyIfNewDay } from "./store";
import { coldCapFor } from "./limits";
import type { SenderInbox } from "./types";

/** Minimum minutes between two sends from the SAME inbox, so one Email ID never
 *  bursts. Env-tunable; 0 disables. Sends simply rotate to a rested inbox. */
function minGapMs(): number {
  const n = Number(process.env.OUTREACH_INBOX_MIN_GAP_MIN);
  const minutes = Number.isFinite(n) && n >= 0 ? n : 20;
  return minutes * 60_000;
}

function rested(m: SenderInbox): boolean {
  const gap = minGapMs();
  if (!gap || !m.lastSendAt) return true;
  const last = Date.parse(m.lastSendAt);
  return !Number.isFinite(last) || Date.now() - last >= gap;
}

function sendable(m: SenderInbox): boolean {
  return (m.status === "active" || m.status === "warming") && m.sentToday < coldCapFor(m) && rested(m);
}

export interface PickOpts { recruiterId?: string; excludeIds?: string[]; }

/** Choose the best inbox to send from. Scoped to a recruiter when recruiterId is set. */
export async function pickSender(workspaceId: string, opts: PickOpts = {}): Promise<SenderInbox | null> {
  await resetDailyIfNewDay(); // date-guarded no-op except on the first pick of a new UTC day
  const exclude = new Set(opts.excludeIds || []);
  const pool = (await listInboxes(workspaceId, { ownerId: opts.recruiterId }))
    .filter((m) => sendable(m) && !exclude.has(m.id))
    .sort((a, b) => (coldCapFor(b) - b.sentToday) - (coldCapFor(a) - a.sentToday));
  return pool[0] || null;
}

/** Remaining send capacity today across a recruiter's pool. */
export async function poolCapacity(
  workspaceId: string,
  recruiterId?: string,
): Promise<{ inboxes: number; remainingToday: number; dailyCapacity: number }> {
  // Capacity ignores the short inter-send rest (it recovers within minutes) but
  // honors status + ramp, so the numbers recruiters see match what can really send.
  const pool = (await listInboxes(workspaceId, { ownerId: recruiterId }))
    .filter((m) => (m.status === "active" || m.status === "warming") && m.sentToday < coldCapFor(m));
  let rem = 0, cap = 0;
  for (const m of pool) { rem += Math.max(0, coldCapFor(m) - m.sentToday); cap += coldCapFor(m); }
  return { inboxes: pool.length, remainingToday: rem, dailyCapacity: cap };
}

export { recordSend };
