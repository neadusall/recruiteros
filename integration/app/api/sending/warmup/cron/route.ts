/**
 * POST or GET /api/sending/warmup/cron
 * Drives the always-running warm-up ENGAGEMENT loop (B). Call this frequently —
 * every few minutes — from your scheduler (n8n FLOW B alongside the LinkedIn/voice
 * ticks). Each tick, per workspace:
 *   - a jittered handful of warming mailboxes send a tagged warm-up message to a
 *     real-provider seed inbox (through the owned Postal MTA), and
 *   - the seed client rescues those messages from spam, opens them, and replies on
 *     a delay over IMAP/SMTP — building positive history AT Gmail/Outlook/Yahoo.
 *
 * Distinct from /api/sending/cron (the once-a-day caps/warm-up-ramp/reputation/
 * governor maintenance). This one is the high-frequency engagement driver.
 *
 * No-op unless SENDING_WARMUP_ENGAGE=1 and drivable seed inboxes exist.
 * Auth: x-cron-secret / ?secret= (RECRUITEROS_CRON_SECRET).
 */

import { NextResponse } from "next/server";
import { requireCronAuth } from "../../../../../lib/linkedin/auth";
import { listSendingWorkspaceIds, runEngagement } from "../../../../../lib/sending";

async function run(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;

  const workspaces = await listSendingWorkspaceIds();
  const results: Array<Record<string, unknown>> = [];
  for (const ws of workspaces) {
    try {
      const report = await runEngagement(ws);
      results.push({ workspaceId: ws, ...report });
    } catch (e: any) {
      results.push({ workspaceId: ws, error: e?.message ?? "engagement_failed" });
    }
  }
  return NextResponse.json({ ok: true, ticked: results.length, results });
}

export const GET = run;
export const POST = run;
