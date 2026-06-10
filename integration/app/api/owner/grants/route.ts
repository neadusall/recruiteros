/**
 * Owner-only: lend a HOUSE integration key to a customer workspace (the resale
 * path), with pricing. Granting flips a customer's integration from isolated to
 * "uses the operator's key"; the markup/monthly terms are what the cost flow bills.
 *
 * GET  /api/owner/grants?workspaceId=ws_x
 *        -> { workspaceId, grantable:[{id,label}], grants:{ id:{markupPct,monthlyUsd,grantedAt} } }
 * POST /api/owner/grants { workspaceId, id, on, markupPct?, monthlyUsd? }
 *        -> { workspaceId, grants, updatedAt }
 *
 * Behind requireOwner: a customer can never grant itself house access.
 */

import { grantsFor, setGrant } from "../../../../lib/connected/access";
import { grantableIntegrations, type IntegrationId } from "../../../../lib/connected";
import { requireOwner, body, ok, fail } from "../../../../lib/api";

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const ws = new URL(req.url).searchParams.get("workspaceId");
  if (!ws) return fail("missing_workspaceId", 422);
  return ok({ workspaceId: ws, grantable: grantableIntegrations(), grants: await grantsFor(ws) });
}

export async function POST(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const b = await body<{
    workspaceId?: string;
    id?: IntegrationId;
    on?: boolean;
    markupPct?: number;
    monthlyUsd?: number;
  }>(req);
  if (!b?.workspaceId || !b?.id) return fail("missing_fields", 422);
  const terms = { markupPct: numOrUndef(b.markupPct), monthlyUsd: numOrUndef(b.monthlyUsd) };
  return ok(await setGrant(b.workspaceId, b.id, b.on !== false, terms));
}

function numOrUndef(n: unknown): number | undefined {
  const v = typeof n === "string" ? parseFloat(n) : (n as number);
  return typeof v === "number" && isFinite(v) && v >= 0 ? v : undefined;
}
