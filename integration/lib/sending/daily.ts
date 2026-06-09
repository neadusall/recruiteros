/**
 * RecruiterOS · Sending daily tick
 * One call the cadence/cron runs once a day per workspace:
 *   reset daily caps → advance warm-up → refresh reputation (SNDS) → run governor
 *   → optional warm-up engagement round.
 * Everything is best-effort and idempotent.
 */

import { resetDaily } from "./caps";
import { advanceWarmup, runWarmupRound } from "./warmup";
import { refreshReputation } from "./reputation";
import { runGovernor } from "./governor";

export interface DailyReport {
  reset: true;
  warmup: { advanced: number; graduated: number };
  reputationUpdated: number;
  paused: Array<{ domain: string; reason: string }>;
  warmupSent: number;
}

export async function runSendingDaily(workspaceId: string): Promise<DailyReport> {
  await resetDaily(workspaceId);
  const warmup = await advanceWarmup(workspaceId);
  let reputationUpdated = 0;
  try { reputationUpdated = await refreshReputation(workspaceId); } catch { /* best-effort */ }
  const paused = await runGovernor(workspaceId);
  let warmupSent = 0;
  try { warmupSent = (await runWarmupRound(workspaceId)).sent; } catch { /* best-effort */ }
  return { reset: true, warmup, reputationUpdated, paused, warmupSent };
}
