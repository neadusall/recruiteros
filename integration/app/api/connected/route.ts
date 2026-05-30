/**
 * GET  /api/connected -> integration statuses + per-motion pre-flight gate
 * POST /api/connected -> { action, id, motion?, ok? }
 *   configure | test | test-all | preflight
 */

import { listIntegrations, configure, testConnection, testAll, preflight, type IntegrationId } from "../../../lib/connected";
import { requireSession, body, ok, fail } from "../../../lib/api";
import type { Motion } from "../../../lib/core/types";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  return ok({ integrations: listIntegrations(g.ctx.workspace.id) });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{ action?: string; id?: IntegrationId; motion?: Motion; ok?: boolean }>(req);

  switch (b?.action) {
    case "configure":
      return b.id ? ok({ integration: configure(ws, b.id) }) : fail("missing_id", 422);
    case "test":
      return b.id ? ok({ integration: await testConnection(ws, b.id, b.ok ?? true) }) : fail("missing_id", 422);
    case "test-all":
      return ok({ integrations: await testAll(ws) });
    case "preflight":
      return ok(preflight(ws, b.motion ?? "bd"));
    default:
      return fail("unknown_action", 400);
  }
}
