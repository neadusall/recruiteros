/**
 * GET /api/phone-intel/calls/[id]
 * One intel call with its full decision timeline (the debugger data, spec §26).
 * Read-only; session-scoped to the caller's workspace.
 */

import { requireSession, ok, fail } from "../../../../../lib/api";
import { ensureIntelReady, getCall } from "../../../../../lib/phoneintel/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  await ensureIntelReady();
  const { id } = await ctx.params;
  const call = getCall(g.ctx.workspace.id, id);
  if (!call) return fail("not_found", 404);
  return ok({ call });
}
