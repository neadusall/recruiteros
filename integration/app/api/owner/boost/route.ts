/**
 * GET /api/owner/boost  (OWNER ONLY)
 * Paid phone lookups (JD Sourcing "Boost phones") across every account: what the
 * skip-trace rung bought, what it found, and what the plan has left.
 *
 * The plan balance is read live from RapidAPI response headers because there is
 * no consumer-facing API for quota; it is cached upstream (see boostUsage.ts) so
 * an open console does not drain the plan it is reporting on.
 *
 *   ?workspaceId=ws_...  probe this account's plan instead of the busiest one
 */

import { requireOwner, ok } from "../../../../lib/api";
import { ensureLedgerReady } from "../../../../lib/billing/ledger";
import { boostUsage } from "../../../../lib/billing/boostUsage";
import { adminListAccounts } from "../../../../lib/auth";

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const url = new URL(req.url);

  await ensureLedgerReady();
  const usage = await boostUsage(url.searchParams.get("workspaceId") || undefined);
  const names = new Map(adminListAccounts().map((a) => [a.workspaceId, a.name]));
  return ok({
    ...usage,
    byWorkspace: usage.byWorkspace.map((w) => ({ ...w, name: names.get(w.workspaceId) ?? w.workspaceId })),
  });
}
