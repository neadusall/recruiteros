/**
 * GET  /api/campaigns -> list campaigns + the 7-phase deploy spec + benchmarks
 * POST /api/campaigns -> create a Draft campaign (phase 2)
 */

import { getCore } from "../../../lib/core/repository";
import { createCampaign, DEPLOY_PHASES, BD_BENCHMARKS } from "../../../lib/campaigns";
import { requireSession, body, ok, fail } from "../../../lib/api";
import type { Motion, ICP, SignalKind, Campaign, SequenceStep } from "../../../lib/core/types";

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
 * PUT /api/campaigns -> upsert a campaign authored in the Campaign Studio.
 * The Studio sends a richer object (steps, channels, etc.); we store it whole,
 * scoped to the caller's workspace, so it persists and is shared across the team.
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

/** DELETE /api/campaigns?id=... -> remove a campaign from the workspace. */
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

/**
 * PUT /api/campaigns -> upsert a Campaign Studio campaign (visual sequence).
 * Accepts the Studio snapshot (id, name, motion, status, steps[], account...)
 * and normalizes it onto the Campaign shape. Looser than POST: only id, name,
 * and motion are required, since a visually built campaign may have no ICP yet.
 */
export async function PUT(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<any>(req);
  if (!b?.id || !b?.name || !b?.motion) return fail("missing_fields", 422);

  const core = getCore();
  const existing = await core.getCampaign(b.id);
  // Ownership guard: never let one workspace overwrite another's campaign.
  if (existing && existing.workspaceId !== g.ctx.workspace.id) return fail("forbidden", 403);

  const sequence: SequenceStep[] = Array.isArray(b.sequence) ? b.sequence : Array.isArray(b.steps) ? b.steps : [];
  const now = new Date().toISOString();
  const campaign: Campaign = {
    id: b.id,
    workspaceId: g.ctx.workspace.id,
    motion: b.motion as Motion,
    name: b.name,
    goal: b.goal ?? existing?.goal ?? "",
    icp: b.icp ?? existing?.icp ?? ({} as ICP),
    signals: (b.signals ?? existing?.signals ?? []) as SignalKind[],
    channels: existing?.channels ?? {},
    methodology: b.methodology ?? existing?.methodology ?? "hiring_manager_outreach",
    voiceNoteThreshold: b.voiceThreshold ?? b.voiceNoteThreshold ?? existing?.voiceNoteThreshold ?? 80,
    dailyCap: b.dailyCap ?? existing?.dailyCap ?? 25,
    status: (b.status ?? existing?.status ?? "draft") as Campaign["status"],
    createdAt: existing?.createdAt ?? b.createdAt ?? now,
    sequence,
    assignee: b.assignee ?? existing?.assignee,
    senderAccount: b.senderAccount ?? b.account ?? existing?.senderAccount,
    updatedAt: now,
  };
  await core.saveCampaign(campaign);
  return ok({ campaign });
}

/** DELETE /api/campaigns?id=... -> remove a campaign owned by this workspace. */
export async function DELETE(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("missing_id", 422);
  const existing = await getCore().getCampaign(id);
  if (existing && existing.workspaceId !== g.ctx.workspace.id) return fail("forbidden", 403);
  await getCore().deleteCampaign(id);
  return ok({ deleted: id });
}
