/**
 * /api/owner/portal-spend  (OWNER ONLY)
 *
 * The owner's approval desk for what shows on a client's app.lumesp "Spending"
 * tab. The owner stages a month-to-month charge here, reviews it, and approves
 * it; only then does the client portal ever return it.
 *
 *   GET    ?workspaceId=   -> { charges }  every row for the account, any status
 *   POST   { workspaceId, label?, source:"monthly_price" }
 *                          -> stage a charge FROM the account's month-to-month
 *                             price field. The amount is not taken from the body;
 *                             it is read server-side from account meta so an
 *                             arbitrary figure can never be pushed to a customer.
 *   PATCH  { workspaceId, id, action:"approve"|"unapprove" }
 *                          -> approve (goes live on the client portal) / pull back
 *   DELETE ?workspaceId=&id=  -> remove a staged row
 */

import { requireOwner, ok, fail, body } from "../../../../lib/api";
import {
  listCharges,
  stageMonthlyCharge,
  approveCharge,
  unapproveCharge,
  deleteCharge,
} from "../../../../lib/owner";
import { getAccountMeta } from "../../../../lib/owner/store";

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) return fail("missing_workspace", 400);
  return ok({ charges: listCharges(workspaceId) });
}

export async function POST(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const b = await body<{ workspaceId?: string; label?: string; source?: string }>(req);
  if (!b || !b.workspaceId) return fail("missing_workspace", 400);

  // Hard rule: the only sendable amount is the account's month-to-month price.
  // We ignore any amount in the body and read it from account meta ourselves.
  if (b.source && b.source !== "monthly_price") return fail("only_monthly_price_allowed", 422);
  const meta = getAccountMeta(b.workspaceId);
  const res = stageMonthlyCharge(b.workspaceId, { amountUsd: meta.monthlyPriceUsd, label: b.label });
  if (res.error === "no_monthly_price") {
    return fail("no_monthly_price", 422, {
      message: "Set a month-to-month price on this account first — that's the only amount you can send.",
    });
  }
  if (!res.charge) return fail(res.error || "could_not_stage", 400);
  return ok({ staged: true, charge: res.charge });
}

export async function PATCH(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const b = await body<{ workspaceId?: string; id?: string; action?: string }>(req);
  if (!b || !b.workspaceId || !b.id) return fail("bad_request", 400);
  const charge =
    b.action === "unapprove"
      ? unapproveCharge(b.workspaceId, b.id)
      : approveCharge(b.workspaceId, b.id);
  if (!charge) return fail("not_found", 404);
  return ok({ updated: true, charge });
}

export async function DELETE(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const id = url.searchParams.get("id");
  if (!workspaceId || !id) return fail("bad_request", 400);
  if (!deleteCharge(workspaceId, id)) return fail("not_found", 404);
  return ok({ deleted: true });
}
