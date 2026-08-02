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
 *
 *   DELETE ?id=<chargeId>   remove one charge from THIS account's statement.
 *     Gated on `team:manage`, which admins AND owners hold: anyone who runs the
 *     account can clear a line off their own bill, but a plain recruiter (who can
 *     view and download it) cannot. Scoped to the session's workspace, so it can
 *     only ever touch a charge on the caller's own account. This is the client-
 *     side mirror of the owner-console Remove; both call the same store, so a
 *     delete here also clears it from the owner console.
 */

import { requireSession, requireCapability, ok, fail } from "../../../lib/api";
import {
  listApprovedCharges,
  approvedMonthlyTotal,
  approvedAnnualTotal,
  approvedOneTimeTotal,
  deleteCharge,
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
    // The actual receipt behind this line, when it was pushed from one. The
    // vault id is NOT exposed; the client fetches the image by CHARGE id via
    // /api/portal-spend/receipt/<id>, which re-checks approval + ownership.
    receipt: c.receipt
      ? {
          vendor: c.receipt.vendor,
          date: c.receipt.chargedAt,
          invoiceNumber: c.receipt.invoiceNumber,
          hasImage: !!(c.receipt.hasShot || c.receipt.hasFile),
          hasFile: !!c.receipt.hasFile,
        }
      : undefined,
  }));
  return ok({
    charges,
    monthlyTotalUsd: approvedMonthlyTotal(workspaceId),
    annualTotalUsd: approvedAnnualTotal(workspaceId),
    oneTimeTotalUsd: approvedOneTimeTotal(workspaceId),
    currency: "USD",
    // Tell the client whether THIS session may remove charges, so the UI shows
    // the delete control to whoever runs the account (admin or owner) and never
    // to a plain viewer.
    canManage: g.ctx.capabilities.includes("team:manage"),
  });
}

export async function DELETE(req: Request) {
  const g = requireCapability(req, "team:manage");
  if ("response" in g) return g.response;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("bad_request", 400);
  // deleteCharge is scoped to (workspaceId, id): passing the session's own
  // workspace means a caller can never reach into another account's statement.
  if (!deleteCharge(g.ctx.workspace.id, id)) return fail("not_found", 404);
  return ok({ deleted: true });
}
