/**
 * GET /api/owner/people  (OWNER ONLY)
 * Who is on the platform and what they can do: account / admin / recruiter
 * counts, the LLM vs enrichment spend split, a full user roster with each
 * user's role-granted functions, and a per-account headcount + activity + cost
 * rollup. The "track all users and all functions of those users" view.
 *   ?window=today|7d|30d|all
 */

import { requireOwner, ok } from "../../../../lib/api";
import { peopleOverview } from "../../../../lib/owner";
import type { SpendWindow } from "../../../../lib/billing/ledger";

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;

  const url = new URL(req.url);
  const window = (url.searchParams.get("window") as SpendWindow) || "30d";

  return ok({ ...peopleOverview(window), owner: g.ctx.user.email });
}
