/**
 * /api/owner/accounts/[id]  (OWNER ONLY)
 *   GET    -> full detail + recent cost events
 *   PATCH  -> set monthly price / tier / notes / suspend|unsuspend
 *   DELETE -> remove the account (identity + all data); same as reset {deleteAccount}
 */

import { requireOwner, ok, fail, body } from "../../../../../lib/api";
import {
  fullAccountDetail,
  updateAccountMeta,
  setAccountSuspended,
  hardReset,
} from "../../../../../lib/owner";
import type { SpendWindow } from "../../../../../lib/billing/ledger";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  const window = (url.searchParams.get("window") as SpendWindow) || "30d";
  const detail = fullAccountDetail(params.id, window);
  if (!detail) return fail("not_found", 404);
  return ok(detail);
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const b = await body<{
    monthlyPriceUsd?: number; tier?: string; notes?: string; suspended?: boolean; atCost?: boolean;
  }>(req);
  if (!b) return fail("bad_request", 400);

  if (typeof b.suspended === "boolean") {
    const okSet = setAccountSuspended(params.id, b.suspended);
    if (!okSet) return fail("not_found", 404);
  }
  const metaPatch: Record<string, unknown> = {};
  if (typeof b.monthlyPriceUsd === "number") metaPatch.monthlyPriceUsd = b.monthlyPriceUsd;
  if (typeof b.tier === "string") metaPatch.tier = b.tier;
  if (typeof b.notes === "string") metaPatch.notes = b.notes;
  if (typeof b.atCost === "boolean") metaPatch.atCost = b.atCost;
  const meta = Object.keys(metaPatch).length ? updateAccountMeta(params.id, metaPatch) : undefined;

  const detail = fullAccountDetail(params.id);
  if (!detail) return fail("not_found", 404);
  return ok({ updated: true, meta, account: detail.account });
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const r = hardReset(params.id, { deleteAccount: true });
  if (!r) return fail("not_found", 404);
  return ok(r);
}
