/**
 * GET /api/owner/accounts  (OWNER ONLY)
 * Every account on the platform, fully joined: identity, members, plan, monthly
 * price, window cost, gross margin, and usage counts.
 *   ?window=today|7d|30d|all
 */

import { requireOwner, ok } from "../../../../lib/api";
import { listFullAccounts } from "../../../../lib/owner";
import type { SpendWindow } from "../../../../lib/billing/ledger";

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  const window = (url.searchParams.get("window") as SpendWindow) || "30d";
  return ok({ window, accounts: listFullAccounts(window) });
}
