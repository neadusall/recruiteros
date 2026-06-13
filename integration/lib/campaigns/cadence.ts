/**
 * RecruitersOS · Campaigns
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
import { pullForProspect } from "../content/library";
import { refreshAutopilots } from "../analytics/autopilot";
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

/** Coarse campaign SignalKind -> a representative SignalType the content library
 *  has a tailored opener for, so even a campaign-level signal (not a per-prospect
 *  one) still speaks to the reason instead of falling back to a generic opener. */
const KIND_TO_SIGNAL: Record<string, string> = {
  fundraising: "funding_round",
  hiring_velocity: "hiring_velocity",
  leadership_change: "exec_hire",
  expansion: "office_expansion",
  layoff: "layoff",
  tech_adoption: "tech_stack_change",
};

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
  /** Sequence touch name (e.g. "Signal Opener") — attribution for Outreach Stats. */
  touch?: string;
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
  // Hands-off loop: re-pin winners for any campaign on autopilot before drafting.
  await refreshAutopilots(workspaceId).catch(() => { /* best-effort, never blocks the run */ });
  const campaigns = (await core.listCampaigns(workspaceId)).filter((c) => c.status === "active");
  const queue: DraftItem[] = [];

  for (const c of campaigns) {
    const prospects = (await core.listProspects(workspaceId, { campaignId: c.id, status: "queued" }))
      .sort((a, b) => b.warmth - a.warmth)
      .slice(0, c.dailyCap);

    for (const p of prospects) {
      // 7:30 enrich (real waterfall when keyed) -> merge resolved contact/role.
      const e = await enrich(p, { motion: c.motion });
      if (e.email && !p.email) p.email = e.email;
      if (e.title && !p.title) p.title = e.title;
      if (e.company && !p.company) p.company = e.company;
      if (e.mobilePhone && !p.mobilePhone) p.mobilePhone = e.mobilePhone;
      if (e.landlinePhone && !p.landlinePhone) p.landlinePhone = e.landlinePhone;
      if (e.source.length) await core.saveProspect(p);
      // 7:45 draft — pull rich, motion-aware copy from the content library.
      queue.push(...draftsFor(c, p));
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
      // Attribution for the Outreach Statistics rollup.
      campaignId: d.campaignId,
      variant: d.variantLabel,
      touch: d.touch,
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

/**
 * 7:45 draft — pull the lead's day-0 touches from the parameterized content
 * library (industry × function × seniority × signal × motion), instead of one
 * generic line. Produces the opening email, the LinkedIn connect note, and, for
 * warm prospects, the voicemail drop — each ready for the approval queue.
 */
function draftsFor(c: Campaign, p: Prospect): DraftItem[] {
  const seq = pullForProspect({
    title: p.title,
    headline: p.headline,
    industry: (p as { industry?: string }).industry || p.company,
    company: p.company,
    firstName: p.firstName,
    fullName: p.fullName,
    warmth: p.warmth,
    motion: c.motion,
    // Speak to the ACTUAL reason: prefer the signal that surfaced THIS prospect,
    // else map the campaign's coarse SignalKind to a representative SignalType. The
    // resolver falls back to a generic opener on an unknown value (never throws).
    signal: (p.signalType || KIND_TO_SIGNAL[c.signals?.[0] ?? ""]) as never,
    voiceThreshold: c.voiceNoteThreshold,
  });

  const label = `${seq.resolved.industry}/${seq.resolved.function}/${seq.resolved.seniority}`;
  const mk = (channel: DraftItem["channel"], subject: string | undefined, body: string, touch: string): DraftItem => ({
    id: rid("draft"), prospectId: p.id, prospectName: p.fullName, campaignId: c.id,
    channel, subject, body, variantLabel: label, touch, status: "pending",
  });

  const out: DraftItem[] = [];
  const email = seq.touches.find((t) => t.channel === "email");
  if (email) out.push(mk("email", email.subject, email.body, email.name));
  const connect = seq.touches.find((t) => t.channel === "linkedin" && t.action === "connect");
  if (connect) out.push(mk("linkedin", undefined, connect.body, connect.name));
  const voice = seq.touches.find((t) => t.channel === "voice"); // hot-only; present when warm
  if (voice) out.push(mk("voice", undefined, voice.body, voice.name));

  // Never enqueue an empty prospect.
  if (!out.length) out.push(mk("email", `A note for ${p.firstName}`, `Hi ${p.firstName}, worth a quick conversation? (${nowIso().slice(0, 10)})`, "Fallback"));
  return out;
}
