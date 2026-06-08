/**
 * POST or GET /api/sending/cron
 * Drives the owned email infrastructure's daily maintenance. Call this once a
 * day (or every few hours — it is idempotent) from your scheduler — n8n, a
 * worker loop, or RecruiterOS's own job runner.
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
import { listSendingWorkspaceIds, runSendingDaily } from "../../../../lib/sending";

async function run(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;

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

  return NextResponse.json({ ok: true, ticked: results.length, results });
}

export const GET = run;
export const POST = run;
