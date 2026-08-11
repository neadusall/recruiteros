/**
 * GET /api/site-visitors  (session, tenant-scoped)
 *
 * Who is on the marketing site. Reads the snapshot the site-visitors resolver
 * writes (snap_site_visitors_v1.json): companies matched against the outbound
 * send ledger (with the exact people we emailed there, recruiter + LinkedIn),
 * plus unmatched corporate networks. Returns { present:false } when there is
 * nothing for this workspace, so the card hides cleanly.
 */

import { requireSession, ok } from "../../../lib/api";
import { loadSnapshot } from "../../../lib/db";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const s = await loadSnapshot<Record<string, unknown>>("site_visitors_v1");
  if (!s || s.workspaceId !== g.ctx.workspace.id) return ok({ present: false });
  return ok({ present: true, ...s });
}
