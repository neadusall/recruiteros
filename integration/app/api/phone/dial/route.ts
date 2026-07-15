/**
 * POST /api/phone/dial
 * Start an outbound browser call: { to, lineId, prospectId?, motion? }
 *
 * The server dials the user's own registered browser first (agent leg); when
 * they pick up, the webhook transfers the leg to the destination with the
 * line's caller ID. Returns the created call record so the UI can attach.
 */

import { requireCapability, ok, fail, body } from "../../../../lib/api";
import { startOutboundCall } from "../../../../lib/phone/calls";
import { linesForUser, getUserState } from "../../../../lib/phone/store";
import type { Motion } from "../../../../lib/core/types";

export async function POST(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const b = await body<{ to?: string; lineId?: string; prospectId?: string; motion?: Motion }>(req);
  if (!b?.to) return fail("missing_number", 400);

  const ws = g.ctx.workspace.id;
  const motion: Motion = b.motion === "recruiting" ? "recruiting" : "bd";
  const isAdmin = g.ctx.capabilities.includes("telnyx:manage");

  // Resolve the line: explicit, else the user's active line, else their only line.
  const mine = linesForUser(ws, g.ctx.user.id, isAdmin, motion);
  let lineId = b.lineId;
  if (!lineId) {
    const st = getUserState(ws, g.ctx.user.id);
    lineId = st.activeLineId && mine.some((l) => l.id === st.activeLineId)
      ? st.activeLineId
      : mine[0]?.id;
  }
  if (!lineId) return fail("no_line: connect a phone number in the Numbers tab first", 409);
  if (!mine.some((l) => l.id === lineId)) return fail("line_not_assigned", 403);

  try {
    const call = await startOutboundCall({
      workspaceId: ws,
      motion,
      userId: g.ctx.user.id,
      userName: g.ctx.user.name,
      to: b.to,
      lineId,
      prospectId: b.prospectId,
    });
    return ok({ call });
  } catch (e: any) {
    return fail(String(e?.message ?? "dial_failed").slice(0, 300), Number(e?.status) || 502);
  }
}
