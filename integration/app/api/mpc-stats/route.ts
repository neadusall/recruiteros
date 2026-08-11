/**
 * GET /api/mpc-stats  (session, tenant-scoped)
 *
 * The BD cockpit's finance-engine feed. Reads the single stats snapshot the MPC tools write
 * (snap_mpc_stats_v1.json) so the Dashboard can show real activity that runs outside the app's
 * native pipeline: sends, reply rate by variant (what's working), replies by sentiment, clean
 * supply ready, and free ATS boards. Returns { present:false } when there's nothing for this
 * workspace, so the card hides cleanly instead of showing zeros.
 */

import { requireSession, ok } from "../../../lib/api";
import { loadSnapshot } from "../../../lib/db";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const s = await loadSnapshot<Record<string, unknown>>("mpc_stats_v1");
  if (!s || s.workspaceId !== g.ctx.workspace.id) return ok({ present: false });
  // The AI advisor's recommendations (written daily), if present for this workspace.
  const adv = await loadSnapshot<Record<string, unknown>>("mpc_advisor_v1");
  const advisor = adv && adv.workspaceId === g.ctx.workspace.id ? adv : null;
  return ok({ present: true, ...s, advisor });
}
