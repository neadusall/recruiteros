/**
 * POST/GET /api/mpc-connect/sweep   (cron secret)
 *
 * Auto-connect sweep: for every video watcher with a resolved LinkedIn profile who hasn't been
 * actioned yet, file a connection request from the recruiter who emailed them. Driven by the q20min
 * MPC tick (x-cron-secret). Every send goes through LinkedIn OS, so pacing/health/suppression cap
 * the real rate; this only enqueues. Gated by MPC_WATCH_AUTOCONNECT (default on),
 * MPC_WATCH_AUTOCONNECT_MIN (open|play|complete, default open).
 */

import { NextResponse } from "next/server";
import { requireCronAuth } from "../../../../lib/linkedin/auth";
import { autoConnectSweep } from "../../../../lib/mpc/watchConnect";

async function run(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;
  const result = await autoConnectSweep();
  return NextResponse.json({ ok: true, ...result });
}

export const GET = run;
export const POST = run;
