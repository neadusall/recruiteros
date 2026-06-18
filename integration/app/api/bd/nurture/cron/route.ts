/**
 * POST or GET /api/bd/nurture/cron
 * Advances the 6-month BD nurture drip. Call every few hours (idempotent) from
 * the scheduler. The real work lives in `runNurtureTick` (lib/bd/nurtureCron) so
 * the in-process Automation scheduler runs the exact same logic without HTTP.
 *
 * Auth: x-cron-secret (RECRUITEROS_CRON_SECRET), matching the other cron ticks.
 */

import { NextResponse } from "next/server";
import { requireCronAuth } from "../../../../../lib/linkedin/auth";
import { runNurtureTick } from "../../../../../lib/bd/nurtureCron";

async function run(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;
  const tick = await runNurtureTick(new Date());
  return NextResponse.json({ ok: true, ...tick });
}

export const GET = run;
export const POST = run;
