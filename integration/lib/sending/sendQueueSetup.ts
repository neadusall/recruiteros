/**
 * RecruitersOS · Send Queue · campaign setup
 *
 * One-click "make this a Send Queue campaign": flips on the sendQueue flag (which turns on the
 * autopilot's send-ready HOLD + the Day-0/Day-1 rhythm), retimes the model so the 1st email fires
 * Day 0 and the 2nd (video) email fires Day 1, and optionally stamps a launch date. It NEVER approves
 * or activates sending — the operator keeps that control; this only sets timing + the gate.
 */

import { getCore } from "../core/repository";

export interface SendQueueSetupResult {
  ok: boolean;
  campaignId: string;
  name: string;
  sendQueue: boolean;
  scheduledFor?: string;
  recruiterId?: string;  // the recruiter whose Sending.ac inbox pool this campaign sends from
  retimed: boolean;      // did we change a touch's day to land on 0/1?
  hasModel: boolean;
  emailTouches: number;
  message: string;       // human summary of what happened / what's still needed
}

export async function setupSendQueueCampaign(
  campaignId: string,
  opts?: { scheduledFor?: string; recruiterId?: string },
): Promise<SendQueueSetupResult> {
  const core = getCore();
  const c = await core.getCampaign(campaignId);
  if (!c) { const e = new Error("campaign_not_found"); (e as Error & { status?: number }).status = 404; throw e; }

  c.sendQueue = true;
  if (opts?.scheduledFor !== undefined) {
    const d = String(opts.scheduledFor).trim();
    c.scheduledFor = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined; // clear on a blank/invalid date
  }
  // Tie the campaign to a recruiter's Sending.ac inbox pool. Without this the send path can't route
  // through the recruiter's inboxes (trySenderPool needs campaign.recruiterId) and falls back to the
  // MTA / Instantly providers. A blank value clears the assignment.
  if (opts?.recruiterId !== undefined) {
    const r = String(opts.recruiterId).trim();
    c.recruiterId = r || undefined;
  }

  // Retime the email touches: first email → Day 0, second email → Day 1 (next-day video). Only the
  // `day` values change — the approved copy is untouched.
  const touches = c.model?.touches ?? [];
  const emailIdx = touches.map((t, i) => (t.channel === "email" ? i : -1)).filter((i) => i >= 0);
  let retimed = false;
  if (emailIdx.length >= 1 && touches[emailIdx[0]].day !== 0) { touches[emailIdx[0]].day = 0; retimed = true; }
  if (emailIdx.length >= 2 && touches[emailIdx[1]].day !== 1) { touches[emailIdx[1]].day = 1; retimed = true; }

  c.updatedAt = new Date().toISOString();
  await core.saveCampaign(c);

  const hasModel = !!(c.model && touches.length);
  const message = !hasModel
    ? "Marked as the Send Queue campaign. It has no approved sequence yet — build a Day-0 text + Day-1 video sequence in Campaign Studio and approve it, then it runs hands-off."
    : emailIdx.length >= 2
      ? "Send Queue campaign ready: 1st email Day 0, video 2nd email Day 1. Only fully send-ready prospects will start the sequence."
      : "Marked as the Send Queue campaign and timed the 1st email to Day 0. Add a 2nd (video) email in Campaign Studio for the Day-1 follow-up.";

  return {
    ok: true,
    campaignId: c.id,
    name: c.name,
    sendQueue: true,
    scheduledFor: c.scheduledFor,
    recruiterId: c.recruiterId,
    retimed,
    hasModel,
    emailTouches: emailIdx.length,
    message,
  };
}
