/**
 * RecruitersOS · ATS background sync scheduler
 *
 * Keeps every connected workspace's Loxo data fresh with ZERO babysitting. Runs
 * IN-PROCESS (a timer in the long-lived Next server) — no external cron, no
 * systemd, no scheduler to point at /api/loxo/cron. It arms once on server boot
 * (via instrumentation.ts) and then ticks forever on an interval.
 *
 * This is the answer to "Sync failed, test the connection first." — instead of a
 * human clicking Test then Sync then re-Sync whenever data drifts, each cycle:
 *   1. Self-heals: a saved-but-unverified ("yellow") connection is TESTED, and
 *      promoted to syncing the moment its credentials check out — so a freshly
 *      entered key starts pulling on its own without anyone clicking Test.
 *   2. Syncs: every verified ("green") connection gets an incremental pull
 *      (People → Candidates, Companies → BD book) from its cursor, which also
 *      backfills anything a missed webhook would have dropped.
 *
 * The same shape as the In-Market accumulator: idempotent arm, overlap guard,
 * unref'd timer, errors swallowed so a bad cycle never touches a user request.
 * The external /api/loxo/cron endpoint still works as a manual/redundant trigger.
 */

import { listSyncableWorkspaces } from "./credentials";
import { testLoxo, syncLoxo } from "./sync";

// 15 min by default. Webhooks (when the account supports them) give real-time;
// this polling tick is the reliable, set-and-forget baseline. Override with
// RECRUITEROS_ATS_SYNC_MS (e.g. tighten in a demo, loosen to spare rate limits).
const CYCLE_MS = positiveIntEnv("RECRUITEROS_ATS_SYNC_MS", 15 * 60 * 1000);
const FIRST_DELAY_MS = 20_000; // let the server settle (and after the accumulator's 8s) before the first pull

let started = false;
let running = false; // overlap guard: never let two cycles run at once

async function runCycle(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const workspaces = await listSyncableWorkspaces();
    for (const { workspaceId, vendor, status } of workspaces) {
      if (vendor !== "loxo") continue; // only Loxo has a real pull engine today
      try {
        // Self-heal a saved-but-unverified connection: a cheap ping promotes it
        // to "green" if the key is good. Skip the sync this tick if it still
        // fails — next cycle retries (the user fixing the key needs no re-click).
        if (status !== "green") {
          const t = await testLoxo(workspaceId);
          if (!t.ok) continue;
        }
        await syncLoxo(workspaceId);
      } catch {
        /* one workspace's failure must not stop the others */
      }
    }
  } catch {
    /* listing failed this tick; next tick tries again */
  } finally {
    running = false;
  }
}

/**
 * Idempotently arm the ATS sync timer. Safe to call repeatedly — it only sets
 * the timers once per process. Errors inside cycles are swallowed.
 */
export function ensureAtsScheduler(): void {
  if (started) return;
  started = true;
  setTimeout(() => { void runCycle(); }, FIRST_DELAY_MS);
  const t = setInterval(() => { void runCycle(); }, CYCLE_MS);
  // Don't keep the event loop alive solely for this timer.
  if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref();
}

function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
