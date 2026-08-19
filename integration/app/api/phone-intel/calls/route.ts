/**
 * GET /api/phone-intel/calls
 * The Phone Intel activity feed: recent calls (timeline summarized; full
 * timeline via /calls/[id]), the dashboard rollup, verified contacts, and the
 * outreach ledger totals (live answers vs voicemails, burned numbers).
 * Read-only; session-scoped to the caller's workspace.
 */

import { requireSession, ok } from "../../../../lib/api";
import { ensureIntelReady, listCalls, listVerifications, dashboard } from "../../../../lib/phoneintel/store";
import { ensureOutreachReady, outreachTotals } from "../../../../lib/phoneintel/outreach";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  await ensureIntelReady();
  await ensureOutreachReady();
  const ws = g.ctx.workspace.id;
  const limit = Math.min(200, parseInt(new URL(req.url).searchParams.get("limit") ?? "60", 10) || 60);

  const calls = listCalls(ws, limit).map((c) => ({
    id: c.id, state: c.state, mode: c.mode,
    companyName: c.companyName, targetFull: c.targetFull, targetTitle: c.targetTitle,
    toNumber: c.toNumber, fromNumber: c.fromNumber,
    answerClass: c.answerClass, disposition: c.disposition, successTypes: c.successTypes,
    extension: c.extension, detectedName: c.detectedName, nameMatchScore: c.nameMatchScore,
    startedAt: c.startedAt, endedAt: c.endedAt, durationSec: c.durationSec,
    eventCount: c.events.length,
  }));

  return ok({
    calls,
    dashboard: dashboard(ws),
    outreach: outreachTotals(ws),
    verifications: listVerifications(ws).slice(0, 50),
  });
}
