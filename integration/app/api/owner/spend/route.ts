/**
 * GET /api/owner/spend  (OWNER ONLY)
 * The unified spend dashboard: total cost in the window, sliced by category,
 * provider, motion, and workspace (with names resolved).
 *   ?window=today|7d|30d|all
 */

import { requireOwner, ok } from "../../../../lib/api";
import { spendRollup, type SpendWindow } from "../../../../lib/billing/ledger";
import { adminListAccounts } from "../../../../lib/auth";

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  const window = (url.searchParams.get("window") as SpendWindow) || "30d";

  const roll = spendRollup(window);
  const names = new Map(adminListAccounts().map((a) => [a.workspaceId, a.name]));
  return ok({
    ...roll,
    byWorkspace: roll.byWorkspace.map((w) => ({ ...w, name: names.get(w.workspaceId) ?? w.workspaceId })),
  });
}
