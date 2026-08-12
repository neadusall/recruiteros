/**
 * GET /api/mpc-watchers  (session, tenant-scoped)
 *
 * Who watched their personalized video, ready to connect with on LinkedIn. Reads the snapshot the
 * mpc-watchers resolver writes (snap_mpc_watchers_v1.json): each person we emailed a video to who
 * then opened/played/completed it, with the recruiter who emailed them and their LinkedIn URL, plus
 * the connect status. Returns { present:false } when there's nothing for this workspace.
 */

import { requireSession, ok } from "../../../lib/api";
import { loadSnapshot } from "../../../lib/db";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const s = await loadSnapshot<Record<string, unknown>>("mpc_watchers_v1");
  if (!s || s.workspaceId !== g.ctx.workspace.id) return ok({ present: false });
  return ok({ present: true, ...s });
}
