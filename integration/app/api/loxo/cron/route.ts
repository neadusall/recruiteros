/**
 * GET|POST /api/loxo/cron -> incremental Loxo sync for every connected workspace.
 *
 * Auth: x-cron-secret (or ?secret=) === RECRUITEROS_CRON_SECRET, matching the
 * other cron ticks (linkedin/cron, sending/cron). Point your scheduler here
 * every few minutes; it re-pulls anything changed since each workspace's cursor,
 * so it also backfills any webhook event that was missed.
 */

import { NextResponse } from "next/server";
import { requireCronAuth } from "../../../../lib/linkedin/auth";
import { listConfiguredWorkspaces, syncLoxo } from "../../../../lib/ats";

async function run(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;

  const workspaces = await listConfiguredWorkspaces();
  const results: Array<Record<string, unknown>> = [];

  for (const { workspaceId, vendor } of workspaces) {
    if (vendor !== "loxo") continue;
    try {
      const report = await syncLoxo(workspaceId);
      results.push({ workspaceId, ...report });
    } catch (e: any) {
      results.push({ workspaceId, error: e?.message ?? "tick_failed" });
    }
  }

  return NextResponse.json({ ok: true, ticked: results.length, results });
}

export const GET = run;
export const POST = run;
