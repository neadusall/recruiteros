/**
 * /api/phone-intel/queue/start — the deliberate, admin-gated trigger.
 *   GET    — current run state (running / placed / skipped / current item)
 *   POST   — start dialing the queued items { maxCalls?, perCompanyGapSec? }
 *   DELETE — request a cooperative stop (current call finishes, nothing more dials)
 *
 * Nothing in Phone Intel dials on its own: the queue is data until an admin
 * presses Start here. The number pool = the workspace's BD phone lines; each
 * contact's line is chosen by the outreach ledger (burned numbers skipped,
 * voicemail-successful number preferred).
 */

import { requireCapability, ok, fail, body } from "../../../../../lib/api";
import { listLines } from "../../../../../lib/phone/store";
import { listQueue } from "../../../../../lib/phoneintel/queue";
import { startQueueRun, stopQueueRun, queueRunState } from "../../../../../lib/phoneintel/runner";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = requireCapability(req, "telnyx:manage");
  if ("response" in g) return g.response;
  return ok({ run: queueRunState(g.ctx.workspace.id) });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "telnyx:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{ maxCalls?: number; perCompanyGapSec?: number }>(req);

  const queued = listQueue(ws, "queued");
  if (!queued.length) return fail("queue_empty", 422, { detail: "Add contacts to the queue first." });

  const pool = listLines(ws).map((l) => l.e164).filter(Boolean);
  if (!pool.length) {
    return fail("no_lines", 422, { detail: "No phone lines on this workspace yet. Connect a number in BD Phone > Numbers first." });
  }

  try {
    const run = await startQueueRun({
      workspaceId: ws,
      numberPool: pool,
      maxCalls: Number.isFinite(b?.maxCalls) ? Math.max(1, Math.floor(b!.maxCalls!)) : undefined,
      perCompanyGapSec: Number.isFinite(b?.perCompanyGapSec) ? Math.max(30, Math.floor(b!.perCompanyGapSec!)) : undefined,
    });
    return ok({ run, pool: pool.length, queued: queued.length });
  } catch (e: any) {
    if (e?.message === "queue_already_running") return fail("already_running", 409);
    return fail("start_failed", 502, { detail: String(e?.message ?? e).slice(0, 200) });
  }
}

export async function DELETE(req: Request) {
  const g = requireCapability(req, "telnyx:manage");
  if ("response" in g) return g.response;
  return ok({ run: stopQueueRun(g.ctx.workspace.id) });
}
