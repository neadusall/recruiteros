/**
 * POST /api/dev/seed -> populate the signed-in workspace with demo data so the
 * Overview, Response inbox and pipeline render immediately. Dev convenience only.
 */

import { seedWorkspace } from "../../../../lib/dev/seed";
import { requireSession, ok } from "../../../../lib/api";

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  return ok(await seedWorkspace(g.ctx.workspace.id));
}
