/**
 * GET  /api/billing -> this workspace's trial / subscription status
 * POST /api/billing -> { action: "subscribe" } start the paid plan
 *                      { action: "cancel" }    drop back to unpaid
 *
 * Admin sign-up is free for a 14-day trial — no card required until it ends.
 * After the trial the workspace must subscribe to keep the Admin Portal.
 *
 * NOTE: this flips the workspace's paid flag directly. It's the seam a real
 * payment processor (Stripe Checkout + webhook) plugs into — swap the body of
 * the "subscribe" branch for a Checkout session and have the webhook call
 * setWorkspacePaid(workspaceId, true). Gated by billing:manage (owner only).
 */

import { trialStatus, setWorkspacePaid } from "../../../lib/auth";
import { requireSession, requireCapability, body, ok, fail } from "../../../lib/api";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  return ok(trialStatus(g.ctx.workspace));
}

export async function POST(req: Request) {
  const g = requireCapability(req, "billing:manage");
  if ("response" in g) return g.response;
  const b = await body<{ action?: string }>(req);
  if (b?.action === "subscribe") {
    const status = setWorkspacePaid(g.ctx.workspace.id, true);
    return status ? ok(status) : fail("not_found", 404);
  }
  if (b?.action === "cancel") {
    const status = setWorkspacePaid(g.ctx.workspace.id, false);
    return status ? ok(status) : fail("not_found", 404);
  }
  return fail("unknown_action", 400);
}
