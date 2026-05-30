/**
 * GET /api/overview -> the real-time dashboard snapshot for the workspace.
 */

import { overview } from "../../../lib/overview";
import { requireSession, ok } from "../../../lib/api";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  return ok(await overview(g.ctx.workspace.id));
}
