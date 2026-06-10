/**
 * Owner-only: lend a HOUSE integration key to a customer workspace (the resale
 * path). Granting flips a customer's integration from isolated to "uses the
 * operator's key" — bill it however the pricing flow decides.
 *
 * GET  /api/owner/grants?workspaceId=ws_x -> { granted: IntegrationId[] }
 * POST /api/owner/grants { workspaceId, id, on } -> { granted: IntegrationId[] }
 *
 * Behind requireOwner: a customer can never grant itself house access.
 */

import { listGrants, setGrant } from "../../../../lib/connected/access";
import { requireOwner, body, ok, fail } from "../../../../lib/api";
import type { IntegrationId } from "../../../../lib/connected";

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const ws = new URL(req.url).searchParams.get("workspaceId");
  if (!ws) return fail("missing_workspaceId", 422);
  return ok({ workspaceId: ws, granted: await listGrants(ws) });
}

export async function POST(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const b = await body<{ workspaceId?: string; id?: IntegrationId; on?: boolean }>(req);
  if (!b?.workspaceId || !b?.id) return fail("missing_fields", 422);
  return ok(await setGrant(b.workspaceId, b.id, b.on !== false));
}
