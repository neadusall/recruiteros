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

  // Mirror the Smartlead warm-up fleet into the per-portal Email ID pools, so
  // every mailbox is a tracked row on its own portal without anyone importing
  // CSVs. Idempotent; refreshes credentials and never clobbers operator edits.
  let fleet: unknown = null;
  try {
    const { syncFleetInboxes } = await import("../../../../lib/senders");
    fleet = await syncFleetInboxes();
  } catch (e: any) { fleet = { error: e?.message ?? "fleet_sync_failed" }; }

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

  // Email ID health guard over every portal's pool: auto-hold cold sends on
  // inboxes going bad (warm-up keeps running so they regain strength) and
  // auto-revive held ones once health recovers, onto the reduced ramp.
  let guard: unknown = null;
  try {
    const { runSenderHealthGuard } = await import("../../../../lib/senders");
    guard = await runSenderHealthGuard();
  } catch (e: any) { guard = { error: e?.message ?? "health_guard_failed" }; }

  // Revive own-smtp logins stuck in error: re-verify and flip error->warming on a
  // successful login, so a just-fixed credential (e.g. a self-healed base64
  // password) rejoins the send rotation hands-off, without waiting for someone to
  // open the Senders panel or for the 24h auth-sweep freshness window.
  let revive: unknown = null;
  try {
    const { listSenderWorkspaceIds } = await import("../../../../lib/senders");
    const { reviveErroredSmtpLogins } = await import("../../../../lib/senders/infra");
    const ids = await listSenderWorkspaceIds();
    let checked = 0, revived = 0, stillFailing = 0;
    for (const ws of ids) {
      try { const r = await reviveErroredSmtpLogins(ws, 60); checked += r.checked; revived += r.revived; stillFailing += r.stillFailing; }
      catch { /* per-workspace best-effort */ }
    }
    revive = { workspaces: ids.length, checked, revived, stillFailing };
  } catch (e: any) { revive = { error: e?.message ?? "revive_failed" }; }

  return NextResponse.json({ ok: true, ticked: results.length, results, seeds, setups, fleet, guard, revive });
}

export const GET = run;
export const POST = run;
