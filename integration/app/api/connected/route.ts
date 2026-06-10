/**
 * GET  /api/connected -> integration catalog + per-workspace status + setup meta
 * POST /api/connected -> { action, id, keys?, motion? }
 *   save | test | test-all | disconnect | preflight
 */

import {
  listIntegrations,
  saveIntegration,
  disconnectIntegration,
  testConnection,
  testAll,
  preflight,
  type IntegrationId,
} from "../../../lib/connected";
import { requireCapability, body, ok, fail } from "../../../lib/api";
import type { Motion } from "../../../lib/core/types";

export async function GET(req: Request) {
  const g = requireCapability(req, "integrations:manage");
  if ("response" in g) return g.response;
  return ok({ integrations: await listIntegrations(g.ctx.workspace.id) });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "integrations:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{
    action?: string;
    id?: IntegrationId;
    keys?: Record<string, string>;
    motion?: Motion;
  }>(req);

  switch (b?.action) {
    case "save":
      if (!b.id) return fail("missing_id", 422);
      return ok({ result: await saveIntegration(ws, b.id, b.keys ?? {}) });
    case "test":
      if (!b.id) return fail("missing_id", 422);
      return ok({ result: await testConnection(ws, b.id) });
    case "test-all":
      return ok({ integrations: await testAll(ws) });
    case "disconnect":
      if (!b.id) return fail("missing_id", 422);
      return ok({ ok: await disconnectIntegration(ws, b.id) });
    case "preflight":
      return ok(await preflight(ws, b.motion ?? "bd"));
    default:
      return fail("unknown_action", 400);
  }
}
