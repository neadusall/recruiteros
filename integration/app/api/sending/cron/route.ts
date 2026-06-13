/**
 * POST or GET /api/sending/cron
 * Drives the owned email infrastructure's daily maintenance. Call this once a
 * day (or every few hours — it is idempotent) from your scheduler — n8n, a
 * worker loop, or RecruitersOS's own job runner.
 *
 * Each tick runs `runSendingDaily` for every workspace that owns a sending
 * domain: reset daily caps -> advance warm-up -> refresh reputation (SNDS) ->
 * run the deliverability governor (auto-pause bouncing/blacklisted domains) ->
 * optional warm-up engagement round. This is the warm-up/health half of the
 * sending stack — without it, mailboxes never graduate warm-up and reputation
 * is never re-evaluated.
 *
 * Auth: shared secret via x-cron-secret header or ?secret= (RECRUITEROS_CRON_SECRET),
 * matching /api/linkedin/cron and /api/voice/cron.
 */

import { NextResponse } from "next/server";
import { requireCronAuth } from "../../../../lib/linkedin/auth";
import { listSendingWorkspaceIds, runSendingDaily, runSeedMaintenance, listAutoSetupWorkspaceIds, advanceAutoSetup } from "../../../../lib/sending";

async function run(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;

  // Drive any in-progress one-click setup forward (provision → DNS verify → mailboxes)
  // so it completes hands-off once the registrar NS + Postal key clear.
  const setups: Array<Record<string, unknown>> = [];
  for (const ws of await listAutoSetupWorkspaceIds()) {
    try { const s = await advanceAutoSetup(ws); setups.push({ workspaceId: ws, done: s.done, gates: s.gates.length }); }
    catch (e: any) { setups.push({ workspaceId: ws, error: e?.message ?? "setup_advance_failed" }); }
  }

  const workspaces = await listSendingWorkspaceIds();
  const results: Array<Record<string, unknown>> = [];

  for (const ws of workspaces) {
    try {
      const report = await runSendingDaily(ws);
      results.push({ workspaceId: ws, ...report });
    } catch (e: any) {
      results.push({ workspaceId: ws, error: e?.message ?? "tick_failed" });
    }
  }

  // Seeds are global (shared across workspaces), so maintain them ONCE per tick:
  // re-verify every login (catch locked accounts / revoked app passwords) and read
  // any due inbox-placement probes back from the seed inboxes.
  let seeds: unknown = null;
  try { seeds = await runSeedMaintenance(); } catch (e: any) { seeds = { error: e?.message ?? "seed_maintenance_failed" }; }

  return NextResponse.json({ ok: true, ticked: results.length, results, seeds, setups });
}

export const GET = run;
export const POST = run;
