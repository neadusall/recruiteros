/**
 * RecruiterOS · Voice Drops · Email-sent reactive trigger
 *
 * The Appendix-A rule (RECRUITEROS-BACKEND.md §4-C): emailing a prospect makes
 * them eligible for a voicemail drop. Rather than reimplement dialing, this
 * enqueues the prospect as a lead into a designated, operator-attested voice
 * campaign; the existing dial tick (`runDueDrops`, fired by the voice cron)
 * then enforces every gate already built — the lead's own local calling window,
 * the daily cap, the frequency cap, line-type filtering (mobiles never dialed),
 * and dry-run safety.
 *
 * Consent is modeled at the campaign level (the operator attests a lawful basis
 * + their own consented cloned voice before a campaign can launch), so the only
 * job here is: pick the target campaign, dedup, classify the number, enqueue.
 *
 * OPT-IN by default — nothing dials on send unless RECRUITEROS_VOICE_ON_SEND is
 * set, so turning email on never silently starts cold-calling.
 */

import { rid } from "../core/ids";
import { classifyLine, type LineType } from "../signals/phoneClassify";
import { resolveTimezone } from "./compliance";
import { ensureVoiceReady, getCampaign, addLead, findLead } from "./store";
import type { VoiceLead } from "./types";
import type { Prospect, Motion } from "../core/types";

export interface VoiceOnSendResult {
  queued: boolean;
  reason?:
    | "disabled"
    | "no_campaign"
    | "campaign_paused"
    | "no_number"
    | "not_dialable"
    | "already_queued";
  campaignId?: string;
  leadId?: string;
}

/** True when the reactive email-sent → voice-drop trigger is switched on. */
export function voiceOnSendEnabled(): boolean {
  const v = (process.env.RECRUITEROS_VOICE_ON_SEND || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Workspace-wide default voice campaign for reactive drops (env fallback). */
function defaultCampaignId(): string | undefined {
  const id = (process.env.RECRUITEROS_VOICE_ON_SEND_CAMPAIGN || "").trim();
  return id || undefined;
}

/**
 * Enqueue a prospect for a voice drop because we just emailed them. Returns a
 * structured result (never throws) so the email send path can fire-and-forget.
 * The campaign target is, in precedence order: the campaign's own linked voice
 * campaign (passed in), then the RECRUITEROS_VOICE_ON_SEND_CAMPAIGN default.
 */
export async function voiceOnEmailSent(
  workspaceId: string,
  prospect: Prospect,
  opts: { motion?: Motion; voiceCampaignId?: string } = {},
): Promise<VoiceOnSendResult> {
  if (!voiceOnSendEnabled()) return { queued: false, reason: "disabled" };
  await ensureVoiceReady();

  const campaignId = opts.voiceCampaignId || defaultCampaignId();
  if (!campaignId) return { queued: false, reason: "no_campaign" };

  const campaign = getCampaign(workspaceId, campaignId);
  if (!campaign) return { queued: false, reason: "no_campaign" };
  if (campaign.status === "paused") return { queued: false, reason: "campaign_paused", campaignId };

  // Prefer the explicitly enriched direct line; fall back to the primary number.
  const number = (prospect.landlinePhone || prospect.phone || "").trim();
  if (!number) return { queued: false, reason: "no_number", campaignId };

  // Idempotent: don't enqueue the same prospect/number twice.
  if (findLead(campaignId, { prospectId: prospect.id, phone: number })) {
    return { queued: false, reason: "already_queued", campaignId };
  }

  // Classify the line — mobiles/toll-free are kept for transparency but flagged
  // so the dial tick can never call them. Best-effort: an error => "unknown".
  let lineType: LineType = "unknown";
  try {
    const cls = await classifyLine(number, { workspaceId, motion: opts.motion ?? campaign.motion });
    lineType = cls.lineType;
  } catch {
    /* leave as "unknown" — the dial tick treats non-landline/voip as undialable */
  }
  const dialable = lineType === "landline" || lineType === "voip";

  const lead: VoiceLead = {
    id: rid("vled"),
    firstName: prospect.firstName || prospect.fullName?.split(/\s+/)[0] || "",
    fullName: prospect.fullName,
    role: prospect.title,
    company: prospect.company,
    phone: number,
    lineType,
    location: prospect.location,
    timezone: resolveTimezone(prospect.location),
    outcome: dialable ? "queued" : "filtered_mobile",
    attempts: 0,
    prospectId: prospect.id,
  };
  addLead(workspaceId, campaignId, lead);

  return {
    queued: dialable,
    reason: dialable ? undefined : "not_dialable",
    campaignId,
    leadId: lead.id,
  };
}
