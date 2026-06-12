/**
 * GET  /api/analytics/outreach -> the Outreach Statistics rollup.
 *   ?motion=bd|recruiting & ?campaign= & ?owner= & ?since=<days|all> & ?channel=
 *
 * POST /api/analytics/outreach -> promote-winners / autopilot.
 *   { action: "apply",     campaignId }            -> pin current winners onto the campaign
 *   { action: "autopilot", campaignId, enabled }   -> turn the hands-off loop on/off
 *
 * Read is gated to analytics:view (every recruiter can see their own numbers);
 * the promote action is gated to campaigns:create.
 */

import { buildOutreachStats } from "../../../../lib/analytics/outreach";
import { applyWinners, setAutopilot } from "../../../../lib/analytics/autopilot";
import { requireCapability, body, ok, fail } from "../../../../lib/api";
import type { Channel, Motion } from "../../../../lib/core/types";

export async function GET(req: Request) {
  const g = requireCapability(req, "analytics:view");
  if ("response" in g) return g.response;
  const q = new URL(req.url).searchParams;
  const sinceRaw = q.get("since");
  const sinceDays = !sinceRaw || sinceRaw === "all" ? null : Number(sinceRaw);
  const stats = await buildOutreachStats(g.ctx.workspace.id, {
    motion: (q.get("motion") as Motion) || undefined,
    campaignId: q.get("campaign") || undefined,
    ownerId: q.get("owner") || undefined,
    sinceDays,
    channel: (q.get("channel") as Channel) || undefined,
  });
  return ok(stats);
}

export async function POST(req: Request) {
  const g = requireCapability(req, "campaigns:create");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{ action?: string; campaignId?: string; enabled?: boolean }>(req);
  if (!b?.campaignId) return fail("missing_campaignId", 422);

  if (b.action === "autopilot") {
    const r = await setAutopilot(ws, b.campaignId, !!b.enabled);
    return r.applied ? ok(r) : fail(r.reason ?? "failed", 404);
  }
  // default: apply current winners once
  const r = await applyWinners(ws, b.campaignId);
  return r.applied ? ok(r) : fail(r.reason ?? "failed", 404);
}
