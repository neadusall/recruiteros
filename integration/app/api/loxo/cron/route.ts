/**
 * GET|POST /api/loxo/cron -> incremental Loxo sync for every connected workspace.
 *          ...?deep=1     -> START the daily crossover audit (deep rescan +
 *                            touch re-mirror + DNC mirror) in the background
 *                            and return immediately. A full audit takes
 *                            minutes (rate-gated Loxo paging), far longer than
 *                            any sane HTTP timeout, so the request only kicks
 *                            it off; completion is visible via ?status=1.
 *          ...?status=1   -> per-workspace last-audit report (no work done).
 *                            The external daily timer triggers with deep=1,
 *                            then polls status=1 until lastRunAt is fresh, so
 *                            the audit is VERIFIED done, not assumed.
 *
 * Auth: x-cron-secret (or ?secret=) === RECRUITEROS_CRON_SECRET, matching the
 * other cron ticks (linkedin/cron, sending/cron). Point your scheduler here
 * every few minutes; it re-pulls anything changed since each workspace's cursor,
 * so it also backfills any webhook event that was missed.
 */

import { NextResponse } from "next/server";
import { requireCronAuth } from "../../../../lib/linkedin/auth";
import { listConfiguredWorkspaces, syncLoxo, dailyLoxoReconcile, lastReconcile } from "../../../../lib/ats";

async function run(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;
  const params = new URL(req.url).searchParams;
  const deep = params.get("deep") === "1";
  const statusOnly = params.get("status") === "1";

  const workspaces = (await listConfiguredWorkspaces()).filter((w) => w.vendor === "loxo");
  const results: Array<Record<string, unknown>> = [];

  if (statusOnly) {
    for (const { workspaceId } of workspaces) {
      const r = await lastReconcile(workspaceId);
      results.push({ workspaceId, at: r.at, auditOk: r.report ? r.report.ok : null, report: r.report });
    }
    return NextResponse.json({ ok: true, status: true, ticked: results.length, results });
  }

  if (deep) {
    // Fire-and-forget: the server is a long-lived container, so the audit
    // finishes after this response returns. Never run it inline here; the
    // request would outlive every proxy timeout in front of the app.
    for (const { workspaceId } of workspaces) {
      void dailyLoxoReconcile(workspaceId).catch((e) =>
        console.warn(`[loxo:reconcile] background run failed ws=${workspaceId}`, e?.message ?? e),
      );
      results.push({ workspaceId, reconcile: "started" });
    }
    return NextResponse.json({ ok: true, deep: true, ticked: results.length, results });
  }

  for (const { workspaceId } of workspaces) {
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
