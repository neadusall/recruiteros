/**
 * /api/portal-spend  (any signed-in member)
 *
 * The client-facing read for the portal "Spending" tab. Returns ONLY the
 * monthly charges the owner has approved for this session's own workspace, plus
 * their total. Pending (unapproved) charges are never returned here, so nothing
 * reaches a customer until the owner has signed off in the owner console.
 *
 * Scope is the session's workspace — a member can only ever see their own
 * statement, never another account's.
 */

import { requireSession, ok } from "../../../lib/api";
import {
  listApprovedCharges,
  approvedMonthlyTotal,
  approvedOneTimeTotal,
} from "../../../lib/owner/portalSpend";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const workspaceId = g.ctx.workspace.id;
  const charges = listApprovedCharges(workspaceId).map((c) => ({
    id: c.id,
    label: c.label,
    amountUsd: c.amountUsd,
    cadence: c.cadence || "monthly",
    since: c.approvedAt || c.createdAt,
  }));
  return ok({
    charges,
    monthlyTotalUsd: approvedMonthlyTotal(workspaceId),
    oneTimeTotalUsd: approvedOneTimeTotal(workspaceId),
    currency: "USD",
  });
}
