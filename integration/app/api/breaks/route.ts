/**
 * POST /api/breaks -> file a break the app just showed someone (client-reported).
 * GET  /api/breaks  -> the newest breaks. Owner sees the whole box; anyone else
 *                      sees only their own workspace.
 *
 * The client posts here from its break notice (assets/js/command.js), so a
 * recruiter saying "it broke, code ROS-SRV" is already backed by the screen,
 * the request and the status on this side. Session-gated: anonymous traffic
 * cannot write into the log.
 */

import { ok, fail, body, requireSession } from "../../../lib/api";
import { isOwnerEmail } from "../../../lib/owner";
import { recordBreak, listBreaks, type BreakInput } from "../../../lib/breaks";

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<BreakInput>(req);
  if (!b) return fail("bad_body", 400);
  try {
    const entry = await recordBreak(b, {
      workspaceId: g.ctx.workspace.id,
      userEmail: g.ctx.user.email || "",
    });
    return ok({ ok: true, id: entry.id });
  } catch (e) {
    // Filing a break must never itself break the screen that is already broken.
    console.warn("[break] not recorded:", (e as Error).message);
    return ok({ ok: false });
  }
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const limit = Number(new URL(req.url).searchParams.get("limit") || 50);
  const owner = isOwnerEmail(g.ctx.user.email);
  return ok({ breaks: await listBreaks(limit, owner ? undefined : g.ctx.workspace.id), owner });
}
