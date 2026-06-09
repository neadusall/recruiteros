/**
 * POST or GET /api/voice/cron
 * Drives Voice Drops. Call this every ~15 min (or every few minutes) from your
 * scheduler — Vercel Cron, a worker loop, or RecruiterOS's own job runner.
 *
 * Each tick runs `runDueDrops` for every RUNNING voice campaign across all
 * workspaces: it dials only the leads currently inside their OWN local calling
 * window, up to each campaign's daily cap, honoring the frequency cap and
 * line-type filter. This is what actually drains the queue the email-sent
 * trigger fills (lib/voice/onEmailSent.ts) — without it, enqueued leads never
 * dial. Idempotent and safe to call repeatedly.
 *
 * Auth: shared secret via x-cron-secret header or ?secret= (RECRUITEROS_CRON_SECRET).
 */

import { NextResponse } from "next/server";
import { requireCronAuth } from "../../../../lib/linkedin/auth";
import { ensureVoiceReady, listRunningCampaigns } from "../../../../lib/voice/store";
import { runDueDrops } from "../../../../lib/voice/campaign";

async function run(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;

  await ensureVoiceReady();
  const at = new Date();
  const results: Array<Record<string, unknown>> = [];

  for (const c of listRunningCampaigns()) {
    try {
      const summary = await runDueDrops(c.workspaceId, c.id, at);
      results.push({ campaignId: c.id, workspaceId: c.workspaceId, ...summary });
    } catch (e: any) {
      results.push({ campaignId: c.id, workspaceId: c.workspaceId, error: e?.message ?? "tick_failed" });
    }
  }

  return NextResponse.json({ ok: true, ticked: results.length, results });
}

export const GET = run;
export const POST = run;
