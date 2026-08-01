/**
 * POST or GET /api/vetting/cron
 * Drives AI Vetting scoring. Call this every ~1-3 min from your scheduler.
 *
 * Each tick runs `reconcilePendingVettingCalls`: it finds inbound vetting calls
 * that aren't scored yet, pulls each one's finished transcript from the Telnyx
 * Conversations API, and runs the shared scorer. This is the SELF-HEALING half of
 * scoring — Telnyx has no post-call transcript webhook, so this pull loop is what
 * actually turns finished calls into scorecards. Idempotent and safe to call
 * repeatedly; a call already scored (e.g. by a webhook path) is skipped.
 *
 * Auth: shared secret via x-cron-secret header or ?secret= (RECRUITEROS_CRON_SECRET).
 */

import { NextResponse } from "next/server";
import { requireCronAuth } from "../../../../lib/linkedin/auth";
import { reconcilePendingVettingCalls } from "../../../../lib/vetting";

async function run(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;

  const summary = await reconcilePendingVettingCalls();
  return NextResponse.json({ ok: true, ...summary });
}

export const GET = run;
export const POST = run;
