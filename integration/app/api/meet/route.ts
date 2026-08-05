/**
 * Ad-hoc meeting tokens for the /meet page (portal-session guarded).
 *
 * GET /api/meet?room=<slug> -> { join: { base, jwt } | null }
 *   join = the self-hosted meet server (RECRUITEROS_MEET_BASE) plus a signed
 *   room token, when the meet stack is configured for this workspace's brand.
 *   null = the page should fall back to the neutral public bridge.
 */

import { ok, fail, requireCapability } from "../../../lib/api";
import { adhocMeetJoin } from "../../../lib/inmarket/booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = requireCapability(req, "outreach:send");
  if ("response" in g) return g.response;
  const room = (new URL(req.url).searchParams.get("room") || "").trim();
  if (!room || !/^[A-Za-z0-9][A-Za-z0-9-]{2,119}$/.test(room)) return fail("bad_room");
  return ok({ join: await adhocMeetJoin(g.ctx.workspace.id, room) });
}
