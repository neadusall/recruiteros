/**
 * GET /api/mpc-sent  (session, tenant-scoped)
 *
 * The "Sent" audit view feed: the real messages the MPC engine sent in the operator's name, with
 * full bodies, so they can review exactly what went out and trust the machine. Newest first.
 */

import { requireSession, ok } from "../../../lib/api";
import { loadSnapshot } from "../../../lib/db";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const s = await loadSnapshot<Record<string, unknown>>("mpc_sent_v1");
  if (!s || s.workspaceId !== g.ctx.workspace.id) return ok({ present: false, messages: [] });
  return ok({ present: true, total: s.total, generatedAt: s.generatedAt, messages: s.messages || [] });
}
