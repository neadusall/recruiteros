/**
 * RecruitersOS · Send Queue — readiness gate + rolling-buffer projection
 *
 * Powers the "always have 4–6K send-ready prospects staged" model. A prospect is SEND-READY only
 * when EVERY asset is in place (strict gate, per the product decision):
 *   1. a verified email   (emailVerification.status === "valid" — Reoon mailbox-confirmed)
 *   2. a composed 2nd-email video (personalizedVideo.videoKey + gifUrl — implies clip + PiP + render)
 *   3. a landing/watch page (personalizedVideo.watchUrl)
 * Anything missing → the prospect is "needs assets" (with a checklist) and does NOT count toward a
 * day's batch. The 2nd (video) email goes out the NEXT day after the 1st (text) email, so steady
 * state is firsts(today) + seconds(yesterday's firsts) ≈ 8–12K/day.
 *
 * This module is READ-ONLY analytics: it computes supply, runway, per-day projection, the
 * needs-assets breakdown, and per-campaign readiness, so the Send Queue dashboard can show — at a
 * glance — whether the next few days are filled and what to fix when they aren't.
 *
 * Tunables (env): SEND_QUEUE_TARGET_MIN (4000), SEND_QUEUE_TARGET_MAX (6000), SEND_QUEUE_BUFFER_DAYS (5).
 */

import { getCore } from "../core/repository";
import type { Prospect } from "../core/types";

const TARGET_MIN = Math.max(1, Number(process.env.SEND_QUEUE_TARGET_MIN) || 4000);
const TARGET_MAX = Math.max(TARGET_MIN, Number(process.env.SEND_QUEUE_TARGET_MAX) || 6000);
const BUFFER_DAYS = Math.min(14, Math.max(1, Number(process.env.SEND_QUEUE_BUFFER_DAYS) || 5));
const DAILY_TARGET = Math.round((TARGET_MIN + TARGET_MAX) / 2);

export type MissingAsset = "verified_email" | "video" | "watch_page";

export interface Readiness { ready: boolean; missing: MissingAsset[] }

/** The strict send-ready gate for one prospect. `missing` lists exactly what's not done yet. */
export function prospectReadiness(p: Prospect): Readiness {
  const missing: MissingAsset[] = [];
  if (!(p.email && p.emailVerification?.status === "valid")) missing.push("verified_email");
  const pv = p.personalizedVideo;
  if (!(pv && pv.videoKey && pv.gifUrl)) missing.push("video"); // videoKey implies clip + PiP + composite
  if (!(pv && pv.watchUrl)) missing.push("watch_page");
  return { ready: missing.length === 0, missing };
}

export interface SendQueueDay {
  date: string;          // YYYY-MM-DD
  dayOffset: number;     // 0 = today
  firstEmails: number;   // projected NEW first (text) emails that day
  secondEmails: number;  // projected video 2nd emails (previous day's firsts)
  total: number;         // firstEmails + secondEmails
  fill: "green" | "yellow" | "red"; // first-email fill vs the 4–6K band
}

export interface CampaignReadiness {
  campaignId: string;
  label: string;
  status?: string;
  ready: number;
  needsAssets: number;
}

export interface SendQueueOverview {
  targetMin: number; targetMax: number; dailyTarget: number; bufferDays: number;
  readySupply: number;     // send-ready prospects staged (status "queued"), not yet sent
  inSequence: number;      // already in the sequence (context; their 2nd emails are the rollover)
  runwayDays: number;      // readySupply / dailyTarget — how many days the buffer covers
  shortfall: number;       // prospects still needed to fill bufferDays × dailyTarget
  needsAssets: { total: number; noVerifiedEmail: number; noVideo: number; noWatch: number };
  days: SendQueueDay[];
  campaigns: CampaignReadiness[];
}

/** Compute the full Send Queue overview for a workspace. `todayIso` anchors the day projection. */
export async function sendQueueOverview(workspaceId: string, todayIso: string): Promise<SendQueueOverview> {
  const core = getCore();
  const [prospects, campaigns] = await Promise.all([
    core.listProspects(workspaceId),
    core.listCampaigns(workspaceId),
  ]);
  const labelOf = new Map(campaigns.map((c) => [c.id, { label: c.name, status: c.status }]));

  // Stageable = the staged inventory awaiting their FIRST send (status "queued"). Replied/booked/
  // won/nurture/closed/do_not_contact are out; in_sequence already started (counted separately).
  const stageable = prospects.filter((p) => p.status === "queued");
  let ready = 0;
  const need = { total: 0, noVerifiedEmail: 0, noVideo: 0, noWatch: 0 };
  const byCampaign = new Map<string, { ready: number; need: number }>();
  for (const p of stageable) {
    const r = prospectReadiness(p);
    const slot = byCampaign.get(p.campaignId) || { ready: 0, need: 0 };
    if (r.ready) { ready++; slot.ready++; }
    else {
      need.total++; slot.need++;
      if (r.missing.includes("verified_email")) need.noVerifiedEmail++;
      if (r.missing.includes("video")) need.noVideo++;
      if (r.missing.includes("watch_page")) need.noWatch++;
    }
    byCampaign.set(p.campaignId, slot);
  }
  const inSequence = prospects.filter((p) => p.status === "in_sequence").length;
  const runwayDays = DAILY_TARGET > 0 ? Math.floor(ready / DAILY_TARGET) : 0;

  // Per-day projection across the buffer window. We spend the ready supply at DAILY_TARGET/day; the
  // video 2nd emails on a day are the previous day's first emails (next-day cadence). Day-0's
  // second emails approximate from those already in_sequence (yesterday's firsts).
  const base = new Date(todayIso);
  const days: SendQueueDay[] = [];
  let remaining = ready;
  let prevFirst = Math.min(inSequence, DAILY_TARGET); // day-0 rollover ≈ yesterday's firsts
  for (let d = 0; d < BUFFER_DAYS; d++) {
    const firstEmails = Math.min(remaining, DAILY_TARGET);
    remaining -= firstEmails;
    const secondEmails = prevFirst;
    const dt = new Date(base.getTime() + d * 86_400_000).toISOString().slice(0, 10);
    const fill: SendQueueDay["fill"] = firstEmails >= TARGET_MIN ? "green" : firstEmails > 0 ? "yellow" : "red";
    days.push({ date: dt, dayOffset: d, firstEmails, secondEmails, total: firstEmails + secondEmails, fill });
    prevFirst = firstEmails;
  }

  const shortfall = Math.max(0, BUFFER_DAYS * DAILY_TARGET - ready);
  const campaignsOut: CampaignReadiness[] = [...byCampaign.entries()]
    .map(([id, v]) => ({ campaignId: id, label: labelOf.get(id)?.label || id, status: labelOf.get(id)?.status, ready: v.ready, needsAssets: v.need }))
    .sort((a, b) => b.ready - a.ready || b.needsAssets - a.needsAssets);

  return {
    targetMin: TARGET_MIN, targetMax: TARGET_MAX, dailyTarget: DAILY_TARGET, bufferDays: BUFFER_DAYS,
    readySupply: ready, inSequence, runwayDays, shortfall, needsAssets: need, days, campaigns: campaignsOut,
  };
}

export interface NeedsAssetItem {
  id: string;
  name: string;
  company?: string;
  title?: string;
  email?: string;
  emailStatus?: string;     // emailVerification.status, so the UI can show why an email isn't "valid"
  campaignId: string;
  missing: MissingAsset[];  // exactly what's not done yet for this prospect
}

/**
 * The per-prospect "needs assets" worklist — the staged ("queued") prospects that are NOT yet
 * send-ready, each with the precise list of what's missing, so the operator can go fix them (verify
 * the email, record the video). Optionally filtered to a single missing asset (the dashboard's
 * "Verified email / 2nd-email video / Landing page" cards each open their own slice). Newest first.
 */
export async function needsAssetsList(
  workspaceId: string,
  opts?: { missing?: MissingAsset; limit?: number },
): Promise<NeedsAssetItem[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 1000);
  const prospects = await getCore().listProspects(workspaceId);
  const out: NeedsAssetItem[] = [];
  // Newest staged first, so the freshest gaps surface at the top.
  const queued = prospects
    .filter((p) => p.status === "queued")
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  for (const p of queued) {
    const r = prospectReadiness(p);
    if (r.ready) continue;
    if (opts?.missing && !r.missing.includes(opts.missing)) continue;
    out.push({
      id: p.id,
      name: p.fullName,
      company: p.company,
      title: p.title,
      email: p.email,
      emailStatus: p.emailVerification?.status,
      campaignId: p.campaignId,
      missing: r.missing,
    });
    if (out.length >= limit) break;
  }
  return out;
}
