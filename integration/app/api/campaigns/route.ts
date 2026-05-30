/**
 * GET    /api/campaigns       -> list campaigns + the 7-phase deploy spec + benchmarks
 * POST   /api/campaigns       -> create a Draft campaign (phase 2)
 * PUT    /api/campaigns       -> upsert a Campaign Studio campaign (visual sequence)
 * DELETE /api/campaigns?id=   -> remove a campaign from the workspace
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

/**
 * Upsert a campaign authored in the Campaign Studio. The Studio sends a richer
 * object (steps, channels, etc.); we store it whole, scoped to the caller's
 * workspace, so it persists and is shared across the team.
 */
export async function PUT(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<any>(req);
  if (!b?.id || !b?.name) return fail("missing_fields", 422);
  const campaign = {
    ...b,
    workspaceId: g.ctx.workspace.id,
    motion: b.motion === "bd" ? "bd" : "recruiting",
    status: b.status ?? "draft",
    createdAt: b.createdAt ?? new Date().toISOString(),
  };
  await getCore().saveCampaign(campaign as any);
  return ok({ campaign });
}

export async function DELETE(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("missing_id", 422);
  const existing = await getCore().getCampaign(id);
  if (existing && existing.workspaceId !== g.ctx.workspace.id) return fail("forbidden", 403);
  await getCore().deleteCampaign(id);
  return ok({ ok: true });
}
