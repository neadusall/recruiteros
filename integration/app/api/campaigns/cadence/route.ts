/**
 * GET  /api/campaigns/cadence -> the daily schedule + the current approval queue
 * POST /api/campaigns/cadence -> run the automated 7:00->7:45 loop now
 *   { action: "approve" | "kill", draftId } -> act on a queued draft
 */

import { runDailyCadence, approvalQueue, setDraftStatus, CADENCE_SCHEDULE } from "../../../../lib/campaigns";
import { requireSession, body, ok, fail } from "../../../../lib/api";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  return ok({ schedule: CADENCE_SCHEDULE, queue: approvalQueue(g.ctx.workspace.id) });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{ action?: string; draftId?: string }>(req);

  if (b?.action === "approve" || b?.action === "kill") {
    if (!b.draftId) return fail("missing_draftId", 422);
    setDraftStatus(ws, b.draftId, b.action === "approve" ? "approved" : "killed");
    return ok({ ok: true });
  }
  const run = await runDailyCadence(ws);
  return ok({ ...run, queue: approvalQueue(ws) });
}
