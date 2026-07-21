/**
 * Voice Drops · Campaigns API
 *   GET    /api/voice/campaigns?motion=     -> this workspace's voice campaigns (+stats)
 *   PUT    /api/voice/campaigns             -> create/update a campaign
 *   DELETE /api/voice/campaigns?id=         -> remove a campaign
 *   POST   /api/voice/campaigns             -> { action: import | attest | launch | run }
 *
 * Session-gated. The compliance gates (consent attestation, caller-ID, consented
 * voice, identifying script, dialable leads) are enforced on `launch` — a draft
 * can never dial until they pass.
 */

import { body, ok, fail, requireCapability } from "../../../../lib/api";
import type { Motion } from "../../../../lib/core/types";
import {
  listCampaigns, getCampaign, upsertCampaign, deleteCampaign, attestConsent, campaignStats,
  importLeads, checkLaunch, runDueDrops, getLeads,
  type VoiceCampaignInput, type RawLead,
} from "../../../../lib/voice";

function asMotion(v: unknown): Motion | undefined {
  return v === "bd" ? "bd" : v === "recruiting" ? "recruiting" : undefined;
}

export async function GET(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const motion = asMotion(new URL(req.url).searchParams.get("motion"));
  const campaigns = listCampaigns(g.ctx.workspace.id, motion).map((c) => ({
    ...c, stats: campaignStats(c.id),
  }));
  return ok({ campaigns });
}

export async function PUT(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const b = await body<VoiceCampaignInput>(req);
  // Name is required to CREATE; an update (id present) may patch a subset of
  // fields — e.g. flipping testMode — without resending everything.
  if (!b?.id && !b?.name) return fail("missing_fields", 422);
  const c = upsertCampaign(g.ctx.workspace.id, b);
  return ok({ campaign: { ...c, stats: campaignStats(c.id) } });
}

export async function DELETE(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("missing_id", 422);
  return ok({ ok: deleteCampaign(g.ctx.workspace.id, id) });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);
  const action = b?.action;
  const campaignId = b?.campaignId;
  if (!action || !campaignId) return fail("missing_fields", 422);

  const c = getCampaign(ws, campaignId);
  if (!c) return fail("not_found", 404);

  switch (action) {
    case "import": {
      const leads: RawLead[] = Array.isArray(b.leads) ? b.leads : [];
      if (!leads.length) return fail("no_leads", 422);
      const summary = await importLeads(ws, c.motion, campaignId, leads);
      return ok({ summary, stats: campaignStats(campaignId) });
    }
    case "attest": {
      const updated = attestConsent(ws, campaignId, g.ctx.user.email);
      return ok({ campaign: updated });
    }
    case "launch": {
      const chk = checkLaunch(c);
      if (!chk.ok) return fail("not_ready", 422, { errors: chk.errors });
      c.status = "running";
      return ok({ campaign: { ...c, stats: campaignStats(campaignId) } });
    }
    case "run": {
      // One dial tick (also safe to wire to a cron during the evening window).
      const summary = await runDueDrops(ws, campaignId);
      return ok({ summary, stats: campaignStats(campaignId), leads: getLeads(campaignId).length });
    }
    default:
      return fail("unknown_action", 422);
  }
}
