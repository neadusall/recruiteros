/**
 * GET  /api/campaigns -> list campaigns + the 7-phase deploy spec + benchmarks
 * POST /api/campaigns -> create a Draft campaign (phase 2)
 */

import { getCore } from "../../../lib/core/repository";
import { createCampaign, DEPLOY_PHASES, BD_BENCHMARKS } from "../../../lib/campaigns";
import { requireSession, body, ok, fail } from "../../../lib/api";
import type { Motion, ICP, SignalKind } from "../../../lib/core/types";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const campaigns = await getCore().listCampaigns(g.ctx.workspace.id);
  return ok({ campaigns, phases: DEPLOY_PHASES, benchmarks: BD_BENCHMARKS });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<{ name?: string; goal?: string; motion?: Motion; icp?: ICP; signals?: SignalKind[] }>(req);
  if (!b?.name || !b?.goal || !b?.motion || !b?.icp) return fail("missing_fields", 422);
  const c = await createCampaign({
    workspaceId: g.ctx.workspace.id,
    motion: b.motion,
    name: b.name,
    goal: b.goal,
    icp: b.icp,
    signals: b.signals ?? [],
  });
  return ok({ campaign: c }, 201);
}
