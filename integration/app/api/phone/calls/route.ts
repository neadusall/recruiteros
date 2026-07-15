/**
 * GET /api/phone/calls
 * Filterable BD call history. Query params mirror the History tab's filter
 * bar: q, direction (inbound|outbound|missed), status, userId, lineId,
 * opportunity, from, to, limit, offset, motion.
 *
 * Each request also runs the pipeline sweep so calls whose Telnyx callbacks
 * were lost surface as failed-with-retry instead of spinning forever.
 */

import { requireCapability, ok } from "../../../../lib/api";
import { queryCalls, ensurePhoneReady } from "../../../../lib/phone/store";
import { sweepPipelines } from "../../../../lib/phone/calls";
import type { Motion } from "../../../../lib/core/types";
import type { CallQuery } from "../../../../lib/phone/types";

export async function GET(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  await ensurePhoneReady();
  sweepPipelines();

  const url = new URL(req.url);
  const p = (k: string) => url.searchParams.get(k) ?? undefined;
  const motion: Motion = p("motion") === "recruiting" ? "recruiting" : "bd";
  const q: CallQuery = {
    q: p("q"),
    direction: p("direction") as CallQuery["direction"],
    status: p("status") as CallQuery["status"],
    userId: p("userId"),
    lineId: p("lineId"),
    opportunity: p("opportunity") as CallQuery["opportunity"],
    from: p("from"),
    to: p("to"),
    limit: p("limit") ? Number(p("limit")) : undefined,
    offset: p("offset") ? Number(p("offset")) : undefined,
  };
  return ok(queryCalls(g.ctx.workspace.id, motion, q));
}
