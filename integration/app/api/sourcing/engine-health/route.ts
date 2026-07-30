/**
 * GET|POST /api/sourcing/engine-health -> check the JD Sourcing discovery engines
 * for every configured workspace and alert the owner when one degrades.
 *
 * Point a scheduler here hourly (see install-engine-health-timer.sh). Existed from
 * 2026-07-30, after Serper ran to zero credits unnoticed and took ~62% of JD
 * Sourcing's candidate supply with it; the first signal was a recruiter complaint.
 *
 *   ?peek=1  -> return the LAST stored report without re-checking (spends nothing).
 *   ?quiet=1 -> run the checks but suppress notifications (for manual inspection).
 *
 * Auth: x-cron-secret (or ?secret=) === RECRUITEROS_CRON_SECRET, matching the other
 * cron ticks (sourcing/night, loxo/cron, linkedin/cron, sending/cron).
 */

import { NextResponse } from "next/server";
import { requireCronAuth } from "../../../../lib/linkedin/auth";
import { checkEngineHealth, lastEngineHealth } from "../../../../lib/sourcing/engineHealth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function run(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;
  const params = new URL(req.url).searchParams;

  if (params.get("peek") === "1") {
    return NextResponse.json({ ok: true, peek: true, ...(await lastEngineHealth()) });
  }

  const report = await checkEngineHealth({ notify: params.get("quiet") !== "1" });
  // `degraded` is the one field a shell script can act on without parsing the rest.
  const degraded = report.filter((w) => w.worst === "down" || w.worst === "low");
  return NextResponse.json({
    ok: true,
    checked: report.length,
    degraded: degraded.length,
    report,
  });
}

export const GET = run;
export const POST = run;
