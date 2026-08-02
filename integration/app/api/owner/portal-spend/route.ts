/**
 * /api/owner/portal-spend  (OWNER ONLY)
 *
 * The owner's approval desk for what shows on a client's app.lumesp "Spending"
 * tab. The owner stages a month-to-month charge here, reviews it, and approves
 * it; only then does the client portal ever return it.
 *
 *   GET    ?workspaceId=   -> { charges }  every row for the account, any status
 *   POST   { workspaceId, label?, source:"monthly_price" }
 *                          -> stage the recurring charge FROM the account's
 *                             month-to-month price field. The amount is not taken
 *                             from the body; it is read server-side from account
 *                             meta so an arbitrary recurring figure can never be
 *                             pushed to a customer.
 *   POST   { workspaceId, source:"usage", label, amountUsd }
 *                          -> push one real usage row (a Cost-by-category or
 *                             Recent-cost-events line from the console) to the
 *                             account's Spending tab as a one-time line item.
 *   PATCH  { workspaceId, id, action:"approve"|"unapprove" }
 *                          -> approve (goes live on the client portal) / pull back
 *   DELETE ?workspaceId=&id=  -> remove a staged row
 */

import { requireOwner, ok, fail, body } from "../../../../lib/api";
import {
  listCharges,
  stageMonthlyCharge,
  stageUsageCharge,
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
  const b = await body<{
    workspaceId?: string;
    label?: string;
    source?: string;
    amountUsd?: number;
    cadence?: string;
    receipt?: {
      receiptId?: string;
      vendor?: string;
      chargedAt?: string;
      invoiceNumber?: string;
      hasShot?: boolean;
      hasFile?: boolean;
    };
  }>(req);
  if (!b || !b.workspaceId) return fail("missing_workspace", 400);

  // Usage push: one real cost row from the console -> a one-time line item. The
  // amount is the row's actual cost, carried in the body; when the row is pushed
  // from a real receipt on the grid, that receipt travels with it (id + details)
  // so the client sees the actual invoice, not just a figure. The owner reviews
  // and approves it before it ever reaches the client.
  if (b.source === "usage") {
    const rc = b.receipt && b.receipt.receiptId
      ? {
          receiptId: String(b.receipt.receiptId),
          vendor: b.receipt.vendor,
          chargedAt: b.receipt.chargedAt,
          invoiceNumber: b.receipt.invoiceNumber,
          hasShot: !!b.receipt.hasShot,
          hasFile: !!b.receipt.hasFile,
        }
      : undefined;
    const cadence = b.cadence === "monthly" ? "monthly" : b.cadence === "annual" ? "annual" : "one_time";
    const u = stageUsageCharge(b.workspaceId, { label: b.label || "", amountUsd: Number(b.amountUsd) || 0, receipt: rc, cadence });
    if (u.error === "missing_label") return fail("missing_label", 422, { message: "This row has no label to send." });
    if (u.error === "no_amount") return fail("no_amount", 422, { message: "This row has no cost to send." });
    if (!u.charge) return fail(u.error || "could_not_stage", 400);
    return ok({ staged: true, charge: u.charge });
  }

  // Recurring charge: the only sendable amount is the account's month-to-month
  // price. We ignore any amount in the body and read it from account meta.
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
