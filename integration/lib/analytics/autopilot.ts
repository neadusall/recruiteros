/**
 * RecruiterOS · Outreach Statistics — promote-winners / autopilot
 *
 * The hands-off loop. "Apply" reads the live recommendations for a campaign and
 * pins them onto `campaign.autopilot` (winning message archetype, top segments,
 * best send hour, channel order). With autopilot ENABLED, the daily cadence
 * re-applies on every run, so the campaign keeps tracking whatever is actually
 * converting without anyone touching it.
 *
 * Deliberately non-destructive: it records the winning configuration on the
 * campaign (read by the drafter/scheduler) rather than deleting variants, so a
 * bad read is always reversible.
 */

import { getCore } from "../core/repository";
import { nowIso } from "../core/ids";
import { buildOutreachStats } from "./outreach";
import type { CampaignAutopilot, Channel } from "../core/types";

function summarize(a: Omit<CampaignAutopilot, "note" | "enabled" | "appliedAt">): string {
  const bits: string[] = [];
  if (a.winningVariant) bits.push(`pinned "${a.winningVariant}"`);
  if (a.channelEmphasis?.length) bits.push(`lead with ${a.channelEmphasis[0]}`);
  if (typeof a.bestSendHour === "number") bits.push(`send around ${String(a.bestSendHour).padStart(2, "0")}:00`);
  if (a.winningSegments?.length) bits.push(`focus ${a.winningSegments.slice(0, 2).join(", ")}`);
  return bits.length ? bits.join(" · ") : "Tracking — not enough volume to pin a winner yet.";
}

/** Compute the current winners for a campaign and write them onto it. */
export async function applyWinners(
  workspaceId: string,
  campaignId: string,
  enable?: boolean,
): Promise<{ applied: boolean; autopilot?: CampaignAutopilot; reason?: string }> {
  const core = getCore();
  const campaign = await core.getCampaign(campaignId);
  if (!campaign || campaign.workspaceId !== workspaceId) return { applied: false, reason: "not_found" };

  const stats = await buildOutreachStats(workspaceId, { motion: campaign.motion, campaignId });
  const recs = stats.recommendations;
  const variantRec = recs.find((r) => r.kind === "variant");
  const segRec = recs.find((r) => r.kind === "segment");
  const hourRec = recs.find((r) => r.kind === "send_hour");
  const chanRec = recs.find((r) => r.kind === "channel");
  // Only PIN message/segment winners that are statistically confident — never
  // auto-promote noise. Send-hour and channel order are directional, so we keep
  // them as soft hints even before significance.
  const base = {
    winningVariant: variantRec?.confident ? variantRec.apply?.winningVariant : undefined,
    winningSegments: segRec?.confident ? segRec.apply?.winningSegments : undefined,
    bestSendHour: hourRec?.apply?.bestSendHour,
    channelEmphasis: chanRec?.apply?.channelEmphasis as Channel[] | undefined,
  };
  const provisional = !base.winningVariant && !!variantRec; // a leader exists but isn't significant yet
  const autopilot: CampaignAutopilot = {
    enabled: enable ?? campaign.autopilot?.enabled ?? false,
    appliedAt: nowIso(),
    ...base,
    note: stats.meta.lowVolume
      ? "Tracking — not enough volume yet to pin a winner."
      : (provisional ? "Provisional · " : "") + summarize(base),
  };
  campaign.autopilot = autopilot;
  campaign.updatedAt = nowIso();
  await core.saveCampaign(campaign);
  return { applied: true, autopilot };
}

/** Turn the hands-off loop on/off for a campaign (also applies immediately). */
export async function setAutopilot(
  workspaceId: string,
  campaignId: string,
  enabled: boolean,
): Promise<{ applied: boolean; autopilot?: CampaignAutopilot; reason?: string }> {
  return applyWinners(workspaceId, campaignId, enabled);
}

/** Cadence hook: run the self-learning optimizer, then re-pin per-campaign winners. */
export async function refreshAutopilots(workspaceId: string): Promise<{ refreshed: number; optimized: number }> {
  const core = getCore();
  // Self-learning loop: promote/retire/spawn outreach methodologies for the
  // workspace's pools. Best-effort so a model hiccup never blocks the cadence.
  let optimized = 0;
  try {
    const { optimizeAll } = await import("../bd/optimizer");
    const results = await optimizeAll(workspaceId);
    optimized = results.reduce((n, r) => n + r.actions.length, 0);
  } catch { /* optimizer is non-blocking */ }

  const campaigns = (await core.listCampaigns(workspaceId)).filter((c) => c.autopilot?.enabled);
  for (const c of campaigns) await applyWinners(workspaceId, c.id, true);
  return { refreshed: campaigns.length, optimized };
}
