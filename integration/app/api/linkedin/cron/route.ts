/**
 * POST or GET /api/linkedin/cron
 * Drives the cadence. Call this every 1 to 5 minutes from your scheduler
 * (Vercel Cron, a worker loop, or RecruitersOS's own job runner).
 *
 * Processes a batch of due enrollments: each one runs its next allowed step
 * through the rate limiter and provider, then reschedules itself.
 */

import { NextResponse } from "next/server";
import { SequenceEngine } from "../../../../lib/linkedin/sequenceEngine";
import { getRepository } from "../../../../lib/linkedin/repository";
import { requireCronAuth } from "../../../../lib/linkedin/auth";

async function run(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const batch = Math.min(Number(url.searchParams.get("batch") ?? 50), 200);

  const engine = new SequenceEngine(getRepository());
  const { processed } = await engine.tick(new Date(), batch);
  return NextResponse.json({ ok: true, processed });
}

export const GET = run;
export const POST = run;
