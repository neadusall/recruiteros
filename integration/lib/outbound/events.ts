/**
 * RecruitersOS · Outbound Performance · event normalizer
 *
 * Joins the fact sources that already record activity into one normalized
 * per-user event stream. NO duplicate tracking: this is a read-side adapter.
 *
 * Sources + double-count rules:
 *  - core ActivityEvent  -> email/sms/voice sends, replies mirror, meetings.
 *    LinkedIn sends are mirrored into core as "linkedin_sent"; those are
 *    IGNORED here because the LinkedIn OS ledger is the richer source
 *    (action type, accept tracking). Core is still used for follow-up
 *    detection across all channels (it has the per-prospect ordering).
 *  - LinkedIn OS ledger  -> connection/message/voice-note/InMail/profile-view.
 *  - PersonIdentity      -> connection accepts (connectedAt).
 *  - Response inbox      -> replies (+ classification), SMS receipts, opt-outs.
 *  - LinkedIn Poster     -> posts published (workspace-attributed unless the
 *    workspace has a single member).
 *
 * Attribution chain: prospect.ownerId -> campaign.recruiterId -> null.
 * Never guess: unattributable activity stays on userId null.
 */

import { getCore } from "../core/repository";
import { recentResponses } from "../response";
import { listMembers } from "../auth/team";
import type { ActivityEvent, Campaign, Prospect } from "../core/types";
import type { OutboundEvent, OutboundEventType } from "./types";

const POSITIVE = new Set(["positive", "soft_yes"]);

export interface NormalizeOpts {
  sinceDays?: number;
}

interface Ctx {
  prospects: Map<string, Prospect>;
  campaigns: Map<string, Campaign>;
}

function attribute(ctx: Ctx, prospectId?: string, campaignId?: string): { userId: string | null; motion: "bd" | "recruiting" | "unknown"; campaignId?: string } {
  const p = prospectId ? ctx.prospects.get(prospectId) : undefined;
  const cid = campaignId || p?.campaignId;
  const c = cid ? ctx.campaigns.get(cid) : undefined;
  const userId = p?.ownerId || c?.recruiterId || null;
  const motion = (p?.motion || c?.motion || "unknown") as "bd" | "recruiting" | "unknown";
  return { userId, motion, campaignId: cid };
}

/** Normalize every outbound fact in the window into OutboundEvent[]. */
export async function collectOutboundEvents(workspaceId: string, opts: NormalizeOpts = {}): Promise<OutboundEvent[]> {
  const sinceDays = opts.sinceDays ?? 35;
  const sinceMs = Date.now() - sinceDays * 86_400_000;
  const inWindow = (iso?: string) => !!iso && Date.parse(iso) >= sinceMs;

  const core = getCore();
  const [prospects, campaigns, activity] = await Promise.all([
    core.listProspects(workspaceId),
    core.listCampaigns(workspaceId),
    core.listAllActivity(workspaceId),
  ]);
  const ctx: Ctx = {
    prospects: new Map(prospects.map((p) => [p.id, p])),
    campaigns: new Map(campaigns.map((c) => [c.id, c])),
  };

  const out: OutboundEvent[] = [];
  const push = (
    id: string, at: string, eventType: OutboundEventType,
    channel: OutboundEvent["channel"], a: ReturnType<typeof attribute>,
    extra?: Partial<OutboundEvent>,
  ) => {
    out.push({
      id, workspaceId, userId: a.userId, eventType, channel, motion: a.motion,
      at, campaignId: a.campaignId, ...extra,
    });
  };

  /* -------- core activity: email / sms / voice sends + meetings ---------- */
  // Ordered sends per prospect for follow-up detection (any channel).
  const sendsByProspect = new Map<string, ActivityEvent[]>();
  for (const e of activity) {
    if (!e.type.endsWith("_sent")) continue;
    (sendsByProspect.get(e.prospectId) ?? sendsByProspect.set(e.prospectId, []).get(e.prospectId)!).push(e);
  }
  for (const list of sendsByProspect.values()) list.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));

  for (const [prospectId, sends] of sendsByProspect) {
    sends.forEach((e, i) => {
      if (!inWindow(e.at)) return;
      const a = attribute(ctx, prospectId, e.campaignId);
      if (e.channel === "email") push(`act_${e.id}`, e.at, "EMAIL_SENT", "email", a, { prospectId, sourceWorkflow: e.touch });
      else if (e.channel === "sms") push(`act_${e.id}`, e.at, "SMS_SENT", "sms", a, { prospectId, sourceWorkflow: e.touch });
      else if (e.channel === "voice") push(`act_${e.id}`, e.at, "VOICE_TOUCH_SENT", "voice", a, { prospectId, sourceWorkflow: e.touch });
      // linkedin_sent is intentionally skipped (ledger below is the source).
      if (i > 0) {
        // Any send after the first touch to a prospect = a completed follow-up.
        const chan = e.channel === "system" ? "email" : (e.channel as OutboundEvent["channel"]);
        push(`fu_${e.id}`, e.at, "FOLLOW_UP_COMPLETED", chan, a, { prospectId });
      }
    });
  }
  for (const e of activity) {
    if (e.type === "discovery_call_booked" && inWindow(e.at)) {
      const a = attribute(ctx, e.prospectId, e.campaignId);
      push(`mtg_${e.id}`, e.at, "MEETING_BOOKED", "email", a, { prospectId: e.prospectId });
    }
  }

  /* --------------- LinkedIn OS ledger: the real LinkedIn feed ------------ */
  try {
    const { listLedger } = await import("../linkedin/os/ledger");
    const rows = await listLedger(workspaceId);
    const LI_MAP: Record<string, OutboundEventType | undefined> = {
      connect: "LINKEDIN_CONNECTION_SENT",
      connect_note: "LINKEDIN_CONNECTION_SENT",
      message: "LINKEDIN_MESSAGE_SENT",
      voice_note: "LINKEDIN_VOICE_NOTE_SENT",
      inmail: "LINKEDIN_INMAIL_SENT",
      profile_view: "LINKEDIN_PROFILE_VIEWED",
    };
    const { listIdentities } = await import("../linkedin/os/identity");
    const ids = await listIdentities(workspaceId);
    const idMap = new Map(ids.map((i) => [i.id, i]));
    const ownerOfIdentity = (identityId?: string): { userId: string | null; prospectId?: string } => {
      const ident = identityId ? idMap.get(identityId) : undefined;
      for (const pid of ident?.prospectIds ?? []) {
        const p = ctx.prospects.get(pid);
        if (p?.ownerId) return { userId: p.ownerId, prospectId: pid };
      }
      return { userId: null, prospectId: ident?.prospectIds?.[0] };
    };

    for (const r of rows) {
      if (r.status !== "success") continue;
      const at = r.completedAt || r.submittedAt || r.requestedAt;
      if (!inWindow(at)) continue;
      const type = LI_MAP[r.actionType];
      if (!type) continue;
      const who = ownerOfIdentity(r.personIdentityId);
      const motion = r.businessUnit === "bd" ? "bd" : "recruiting";
      out.push({
        id: `li_${r.id}`, workspaceId, userId: who.userId, eventType: type,
        channel: "linkedin", motion, at, campaignId: r.campaignId,
        prospectId: who.prospectId, provider: "linkedin_os", sourceWorkflow: r.sourceType,
      });
    }
    for (const ident of ids) {
      if (inWindow(ident.connectedAt)) {
        const who = ownerOfIdentity(ident.id);
        out.push({
          id: `liacc_${ident.id}`, workspaceId, userId: who.userId,
          eventType: "LINKEDIN_CONNECTION_ACCEPTED", channel: "linkedin",
          motion: "unknown", at: ident.connectedAt as string, prospectId: who.prospectId,
          provider: "linkedin_os",
        });
      }
    }
  } catch { /* LinkedIn OS not available in this build */ }

  /* --------------------- replies / SMS receipts / opt-outs --------------- */
  try {
    const responses = await recentResponses(workspaceId, 5000);
    const firstReplyByProspect = new Map<string, string>();
    for (const r of responses) {
      const at = r.inbound.receivedAt;
      if (!inWindow(at)) continue;
      const pid = r.inbound.prospectId || undefined;
      const a = attribute(ctx, pid);
      const chan = (r.inbound.channel || "email") as OutboundEvent["channel"];
      const cls = r.classification.class;
      const base: OutboundEventType =
        chan === "sms" ? "SMS_RECEIVED" :
        chan === "linkedin" ? "LINKEDIN_MESSAGE_REPLIED" : "EMAIL_REPLIED";
      push(`resp_${r.inbound.id}`, at, base, chan, a, { prospectId: pid });
      if (POSITIVE.has(cls) && chan !== "sms") {
        push(`pos_${r.inbound.id}`, at, "EMAIL_POSITIVE_REPLY", chan, a, { prospectId: pid, metadata: { class: cls } });
      }
      if (cls === "stop" && chan === "sms") {
        push(`stop_${r.inbound.id}`, at, "SMS_OPT_OUT", "sms", a, { prospectId: pid });
      }
      // Conversation-started: this prospect's FIRST reply in the window.
      if (pid && !firstReplyByProspect.has(pid)) {
        firstReplyByProspect.set(pid, at);
        const evType: OutboundEventType = a.motion === "bd" ? "BD_OPPORTUNITY_CREATED" : "CANDIDATE_CONVERSATION_STARTED";
        push(`conv_${r.inbound.id}`, at, evType, chan, a, { prospectId: pid });
      }
    }
  } catch { /* response pipeline unavailable */ }

  /* ------------------------- LinkedIn posts ------------------------------ */
  try {
    const { getState } = await import("../linkedin/poster");
    const poster = await getState(workspaceId);
    const members = listMembers(workspaceId);
    const soleUser = members.length === 1 ? members[0].userId : null;
    for (const d of poster.drafts) {
      if (d.status === "posted" && inWindow(d.postedAt)) {
        out.push({
          id: `post_${d.id}`, workspaceId, userId: soleUser,
          eventType: "LINKEDIN_POST_PUBLISHED", channel: "content", motion: "unknown",
          at: d.postedAt as string, provider: d.provider,
        });
      }
    }
  } catch { /* poster unavailable */ }

  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return out;
}
