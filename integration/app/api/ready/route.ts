/**
 * GET /api/ready            -> readiness for every tool in this workspace
 * GET /api/ready?tool=ostext -> one tool
 *
 * Session-gated on purpose and NOT capability-gated: a recruiter has to be able
 * to learn that OS Text cannot send, even though they are not allowed to open
 * Integrations. (The Telnyx strip once probed /connected, which IS
 * integrations:manage gated, and every recruiter got a permission banner for
 * their trouble.) Nothing here is a secret: names of connections and whether
 * they are set up, never a key or a value.
 */

import { requireSession, ok, fail } from "../../../lib/api";
import { allToolReadiness, isToolKey, toolReadiness } from "../../../lib/ready";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  // Who can act on the answer decides the wording of the fix on screen.
  const canFix = g.ctx.capabilities.includes("integrations:manage");
  const tool = new URL(req.url).searchParams.get("tool");

  if (tool) {
    if (!isToolKey(tool)) return fail("unknown_tool", 404);
    const r = await toolReadiness(g.ctx.workspace.id, tool);
    return ok({ canFix, tool: r });
  }
  return ok({ canFix, tools: await allToolReadiness(g.ctx.workspace.id) });
}
