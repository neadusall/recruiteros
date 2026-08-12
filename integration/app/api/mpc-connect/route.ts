/**
 * POST /api/mpc-connect   (session, outreach:send)
 *   Body { email }. Fire a LinkedIn connection request to a video watcher, from the recruiter who
 *   emailed them, through LinkedIn OS (policy/pacing/health/suppression/idempotency all apply).
 *
 * GET /api/mpc-connect     (session, outreach:send) -> the connects log for this workspace.
 */

import { requireCapability, ok, fail } from "../../../lib/api";
import { loadSnapshot } from "../../../lib/db";
import { connectWatcherByEmail } from "../../../lib/mpc/watchConnect";

export async function GET(req: Request) {
  const g = requireCapability(req, "outreach:send");
  if ("response" in g) return g.response;
  const log = (await loadSnapshot<{ workspaceId?: string; items?: unknown[] }>("mpc_connects_v1")) || {};
  const items = log.workspaceId === g.ctx.workspace.id ? log.items || [] : [];
  return ok({ items });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "outreach:send");
  if ("response" in g) return g.response;
  let body: { email?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const email = String(body.email || "").toLowerCase().trim();
  if (!email) return fail("email_required", 400);

  const res = await connectWatcherByEmail(g.ctx.workspace.id, email, g.ctx.user.id);
  if ("error" in res) return fail(res.error, res.code);
  return ok({ status: res.status, reason: res.reason });
}
