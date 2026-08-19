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
import { queryCalls, getLine, ensurePhoneReady } from "../../../../lib/phone/store";
import { sweepPipelines } from "../../../../lib/phone/calls";
import { listMembers } from "../../../../lib/auth/team";
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
  const ws = g.ctx.workspace.id;
  const r = queryCalls(ws, motion, q);

  // Unanswered inbound calls have no user on the record, but the caller was
  // still calling somebody: the recruiter(s) assigned to the line they dialed.
  // Decorate those rows so history can show who the call was for.
  let names: Map<string, string> | null = null;
  const calls = r.calls.map((c) => {
    if (c.userName || !c.lineId) return c;
    const line = getLine(ws, c.lineId);
    if (!line?.assignedUserIds.length) return c;
    if (!names) {
      names = new Map();
      try {
        for (const m of listMembers(ws)) names.set(m.userId, m.name || m.email);
      } catch { /* roster unavailable: rows just stay undecorated */ }
    }
    const lineUserNames = line.assignedUserIds
      .map((id) => names!.get(id))
      .filter((n): n is string => Boolean(n));
    return lineUserNames.length ? { ...c, lineUserNames } : c;
  });
  return ok({ calls, total: r.total });
}
