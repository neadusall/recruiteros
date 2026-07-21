/**
 * GET    /api/campaigns       -> list campaigns + the 7-phase deploy spec + benchmarks
 * POST   /api/campaigns       -> create a Draft campaign (phase 2)
 * PUT    /api/campaigns       -> upsert a Campaign Studio campaign (visual sequence)
 * PATCH  /api/campaigns       -> toggle Autopilot (hands-off run) on a campaign
 *   { id, autoRun: boolean }  -> sets campaign.autoRun (+ activates it when turning on)
 * DELETE /api/campaigns?id=   -> remove a campaign from the workspace
 */

import { getCore } from "../../../lib/core/repository";
import { createCampaign, DEPLOY_PHASES, BD_BENCHMARKS } from "../../../lib/campaigns";
import { requireSession, requireCapability, body, ok, fail } from "../../../lib/api";
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
  // Autopilot (hands-off run) is BD-only; a recruiting campaign can never arm it.
  if (campaign.motion !== "bd") (campaign as any).autoRun = false;
  // Going live is a separate right from drafting: without campaigns:activate
  // (members, demo workspaces) a save can never arm a run — the campaign is
  // clamped to draft and Autopilot stays off, whatever the client sent.
  if (!g.ctx.capabilities.includes("campaigns:activate")) {
    campaign.status = "draft";
    (campaign as any).autoRun = false;
  }
  await getCore().saveCampaign(campaign as any);
  return ok({ campaign });
}

/**
 * Toggle Autopilot (hands-off run mode) on a single campaign. When turning it
 * ON we also flip status to "active" — an Autopilot campaign that isn't active
 * would never be picked up by the cadence tick, so "Autopilot on" implies "run".
 * Turning it OFF leaves status alone (you may want it active but human-gated).
 */
export async function PATCH(req: Request) {
  // Arming Autopilot activates the campaign, so this is the activation right.
  const g = requireCapability(req, "campaigns:activate");
  if ("response" in g) return g.response;
  const b = await body<{ id?: string; autoRun?: boolean }>(req);
  if (!b?.id || typeof b.autoRun !== "boolean") return fail("missing_fields", 422, { detail: "id and autoRun (boolean) are required" });
  const core = getCore();
  const c = await core.getCampaign(b.id);
  if (!c) return fail("not_found", 404);
  if (c.workspaceId !== g.ctx.workspace.id) return fail("forbidden", 403);
  if (b.autoRun && c.motion !== "bd") return fail("bd_only", 422, { detail: "Autopilot runs BD campaigns only." });
  c.autoRun = b.autoRun;
  if (b.autoRun && c.status !== "active") c.status = "active";
  c.updatedAt = new Date().toISOString();
  await core.saveCampaign(c);
  return ok({ campaign: c });
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
