/**
 * RecruiterOS · Campaigns
 * The Daily Cadence: the automated morning loop that runs every active campaign.
 *
 * Reference schedule:
 *   7:00  pull signals (last 24h) for each active campaign
 *   7:15  score / rank / dedupe vs ATS; top N (dailyCap) advance
 *   7:30  enrichment waterfall finds the right contacts
 *   7:45  LLM drafts email + LinkedIn + voice per prospect (A/B variants applied)
 *   8:30  human approval queue (15-20 min)
 *   9:00  push to channels (Instantly / Unipile / TalTxt); log person_events
 *   all day  process replies via the Response pipeline
 *
 * This module orchestrates the 7:00->7:45 automated portion and surfaces the
 * approval queue. Wire a cron (Vercel Cron / QStash) to `runDailyCadence`.
 */

import { getCore } from "../core/repository";
import { rid, nowIso } from "../core/ids";
import { enrich, sendTouch } from "../channels";
import type { Campaign, Prospect } from "../core/types";

export interface CadenceStage {
  at: string;            // "07:00"
  name: string;
  automated: boolean;
  detail: string;
}

export const CADENCE_SCHEDULE: CadenceStage[] = [
  { at: "07:00", name: "Pull signals", automated: true, detail: "Run enabled signal sources for each active campaign (last 24h)." },
  { at: "07:15", name: "Score, rank, dedupe", automated: true, detail: "Composite score per ICP; suppress disqualifiers; dedupe vs ATS; top N advance." },
  { at: "07:30", name: "Enrich", automated: true, detail: "Waterfall (Fresh LinkedIn + Tomba) resolves the right contacts." },
  { at: "07:45", name: "LLM draft", automated: true, detail: "Claude drafts email + LinkedIn + voice per prospect; A/B variants applied." },
  { at: "08:30", name: "Approval queue", automated: false, detail: "Edit / kill / approve the batch; record HOT-tier voice notes." },
  { at: "09:00", name: "Push to channels", automated: true, detail: "Emails -> Instantly, LinkedIn -> Unipile, SMS -> TalTxt; person_events logged." },
];

/** An item awaiting human approval in the 8:30 queue. */
export interface DraftItem {
  id: string;
  prospectId: string;
  prospectName: string;
  campaignId: string;
  channel: "email" | "linkedin" | "voice";
  subject?: string;
  body: string;
  variantLabel: string;
  status: "pending" | "approved" | "killed";
}

const queues = new Map<string, DraftItem[]>(); // workspaceId -> queue

export function approvalQueue(workspaceId: string): DraftItem[] {
  return queues.get(workspaceId) ?? [];
}

export function setDraftStatus(workspaceId: string, draftId: string, status: DraftItem["status"]): void {
  const q = queues.get(workspaceId) ?? [];
  const d = q.find((x) => x.id === draftId);
  if (d) d.status = status;
}

/**
 * Run the automated 7:00->7:45 portion for one workspace. In the reference build
 * the signal/enrich/draft steps are stubbed to demonstrate the flow; wire the
 * real signal sources and the LLM drafter (campaigns/draft) where marked.
 */
export async function runDailyCadence(workspaceId: string): Promise<{ drafted: number; campaigns: number }> {
  const core = getCore();
  const campaigns = (await core.listCampaigns(workspaceId)).filter((c) => c.status === "active");
  const queue: DraftItem[] = [];

  for (const c of campaigns) {
    const prospects = (await core.listProspects(workspaceId, { campaignId: c.id, status: "queued" }))
      .sort((a, b) => b.warmth - a.warmth)
      .slice(0, c.dailyCap);

    for (const p of prospects) {
      // 7:30 enrich (real waterfall when keyed) -> merge resolved contact/role.
      const e = await enrich(p);
      if (e.email && !p.email) p.email = e.email;
      if (e.title && !p.title) p.title = e.title;
      if (e.company && !p.company) p.company = e.company;
      if (e.source.length) await core.saveProspect(p);
      // 7:45 draft.
      queue.push(draftFor(c, p));
    }
  }

  queues.set(workspaceId, queue);
  return { drafted: queue.length, campaigns: campaigns.length };
}

/**
 * 9:00 push: send every approved draft on its channel via the real providers
 * (dry-logs until keys are set), logging a person_event per touch. Returns the
 * per-channel send results.
 */
export async function pushApproved(workspaceId: string): Promise<{ sent: number; results: any[] }> {
  const core = getCore();
  const queue = (queues.get(workspaceId) ?? []).filter((d) => d.status === "approved");
  const results: any[] = [];
  for (const d of queue) {
    const prospect = await core.getProspect(d.prospectId);
    if (!prospect) continue;
    const campaign = await core.getCampaign(d.campaignId);
    const res = await sendTouch(workspaceId, {
      channel: d.channel === "voice" ? "voice" : d.channel,
      prospect,
      text: d.body,
      subject: d.subject,
      campaignChannelIds: {
        instantlyCampaignId: campaign?.channels.instantlyCampaignId,
        linkedinAccountId: campaign?.channels.linkedinAccountId,
      },
    });
    // Advance the prospect into the live sequence on first send.
    if (res.ok && prospect.status === "queued") {
      prospect.status = "in_sequence";
      prospect.dripStage = 1;
      await core.saveProspect(prospect);
    }
    results.push({ draftId: d.id, ...res });
  }
  return { sent: results.filter((r) => r.ok).length, results };
}

function draftFor(c: Campaign, p: Prospect): DraftItem {
  // Placeholder draft; the real drafter (Claude) produces subject/body per touch.
  return {
    id: rid("draft"),
    prospectId: p.id,
    prospectName: p.fullName,
    campaignId: c.id,
    channel: "email",
    subject: `${p.company ?? "your team"} just hit a hiring signal`,
    body: `Hi ${p.firstName}, noticed ${p.company ?? "your company"} is moving on ${c.icp.persona}. Worth sending a quick note on how we'd help? (drafted ${nowIso().slice(0, 10)})`,
    variantLabel: "Direct Hook",
    status: "pending",
  };
}
