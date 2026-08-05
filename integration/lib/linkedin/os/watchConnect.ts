/**
 * RecruitersOS · LinkedIn OS
 * Watch-to-connect: when a prospect WATCHES their personalized video (the
 * second-email touch), queue a note-less LinkedIn connection request FROM THE
 * RECRUITER WHO SENT THE EMAIL, and keep a durable per-prospect record so the
 * portal can show the watched -> requested -> sent -> accepted -> meeting
 * funnel. First of the behavior-triggered outreach family.
 *
 * Design rules:
 *  - Once per prospect, ever (own store + engine idempotency key).
 *  - Never sends from the wrong seat: no recruiter seat binding -> recorded
 *    skip, visible in the funnel, NOT a fallback to someone else's account.
 *  - All pacing/safety stays in the engine (policies, pressure, health).
 */

import { rid, nowIso } from "../../core/ids";
import { getCore } from "../../core/repository";
import { listMembers } from "../../auth/team";
import { getInbox } from "../../senders";
import { seatForUser } from "../seats";
import { watchConnects } from "./store";
import { requestLinkedInAction } from "./engine";
import { ensureAccount, listAccounts } from "./health";
import { putPolicy } from "./policy";
import { listLedger } from "./ledger";
import { getIdentity } from "./identity";
import type { WatchConnectRecord } from "./types";

/** The ledger tag every watch-triggered action carries (stats filter on it). */
export const WATCH_CONNECT_WORKFLOW = "video_watch_connect";

/**
 * Entry point, called (fire-and-forget) from the public watch-page beacon on
 * a "play" event. Must never throw into the beacon path.
 */
export async function handleVideoWatch(prospectId: string, videoKey: string): Promise<void> {
  try {
    await handle(prospectId, videoKey);
  } catch (err) {
    console.error("[watch-connect]", (err as Error).message);
  }
}

async function handle(prospectId: string, videoKey: string): Promise<void> {
  const core = getCore();
  const p = await core.getProspect(prospectId);
  if (!p) return; // forged/stale rcpt: nothing to attribute, nothing to store

  const ws = p.workspaceId;

  // Once per prospect, ever.
  const all = await watchConnects.all();
  if (all.some((r) => r.workspaceId === ws && r.prospectId === prospectId)) return;

  const rec: WatchConnectRecord = {
    id: rid("vwc"),
    workspaceId: ws,
    prospectId,
    videoKey,
    watchedAt: nowIso(),
    status: "skipped",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  all.push(rec);

  // Durable audit on the prospect timeline regardless of outcome.
  try {
    await core.recordActivity({
      id: rid("act"),
      workspaceId: ws,
      prospectId,
      channel: "system",
      type: "video_watched",
      summary: "Watched their personalized video",
      at: rec.watchedAt,
      campaignId: p.campaignId,
    } as Parameters<typeof core.recordActivity>[0]);
  } catch { /* timeline is best-effort */ }

  if (!p.linkedinUrl) {
    rec.skipReason = "no_linkedin_url";
    finish(rec);
    return;
  }

  // Who sent the email: exact inbox owner first, then the campaign's
  // recruiter, then the prospect owner. Never guess past that.
  const campaign = p.campaignId ? await core.getCampaign(p.campaignId) : null;
  let userId: string | null = null;
  if (p.senderInboxId) {
    try {
      const inbox = await getInbox(ws, p.senderInboxId);
      userId = inbox?.ownerId ?? null;
    } catch { /* fall through to the campaign chain */ }
  }
  userId = userId || campaign?.recruiterId || p.ownerId || null;
  if (!userId) {
    rec.skipReason = "no_recruiter_attribution";
    finish(rec);
    return;
  }
  const member = listMembers(ws).find((m) => m.userId === userId);
  rec.recruiterUserId = userId;
  rec.recruiterName = member?.name;

  // The recruiter's OWN LinkedIn seat. No seat = recorded skip, never a
  // send from someone else's account.
  const seat = await seatForUser(ws, userId);
  if (!seat || seat.status !== "ok") {
    rec.skipReason = seat ? "seat_needs_reconnect" : "no_linkedin_seat";
    finish(rec);
    return;
  }

  // Engine account for that seat: reuse any account already bound to this
  // provider id (avoids double caps on one LinkedIn login), else register one
  // on the conservative starting policy.
  const osAccounts = await listAccounts(ws);
  let osAccountId = osAccounts.find((a) => a.providerAccountId === seat.accountId)?.accountId;
  if (!osAccountId) {
    osAccountId = `seat_${userId}`;
    await ensureAccount(ws, osAccountId, {
      providerAccountId: seat.accountId,
      displayName: member?.name || seat.label || osAccountId,
      ownerUserId: userId,
      connected: true,
      timezone: "America/New_York",
    });
    try {
      await putPolicy(ws, osAccountId, { applyPreset: "conservative", timezone: "America/New_York" });
    } catch { /* policy stays at the engine default if this races */ }
  }
  rec.osAccountId = osAccountId;

  const res = await requestLinkedInAction({
    workspaceId: ws,
    accountId: osAccountId,
    person: {
      prospectId,
      linkedinUrl: p.linkedinUrl,
      email: p.email,
      fullName: p.fullName,
      company: p.company,
      title: p.title,
    },
    actionType: "connect", // note-less by design: payload.note deliberately absent
    payload: { linkedinUrl: p.linkedinUrl },
    businessUnit: "bd",
    sourceType: "ai_workflow", // keeps pressure + pause + conflict guards active
    priority: "high", // they are watching NOW; land while warm
    campaignId: p.campaignId,
    workflowId: WATCH_CONNECT_WORKFLOW,
    idempotencyKey: `vwc|${ws}|${prospectId}`,
  });

  rec.personIdentityId = res.record.personIdentityId;
  rec.actionId = res.record.id;
  if (res.accepted || res.record.status === "capacity_pending") {
    // Waiting for tomorrow's capacity still counts as queued in the funnel.
    rec.status = "queued";
    rec.skipReason = undefined;
  } else {
    rec.status = "skipped";
    rec.skipReason = res.reason || res.record.status;
  }
  finish(rec);
}

function finish(rec: WatchConnectRecord): void {
  rec.updatedAt = nowIso();
  watchConnects.save();
}

/* ---------------- the correlation funnel ---------------- */

export interface WatchConnectStats {
  watched: number;
  requested: number;
  sent: number;
  accepted: number;
  meetings: number;
  skipped: number;
  /** skipReason -> count, so a stuck funnel explains itself. */
  skipReasons: Record<string, number>;
  recent: Array<{
    prospectName?: string;
    recruiterName?: string;
    watchedAt: string;
    status: string;
  }>;
}

export async function watchConnectStats(workspaceId: string): Promise<WatchConnectStats> {
  const core = getCore();
  const records = (await watchConnects.all()).filter((r) => r.workspaceId === workspaceId);
  const ledger = await listLedger(workspaceId);
  const byAction = new Map(ledger.map((r) => [r.id, r]));

  let requested = 0, sent = 0, accepted = 0, meetings = 0, skipped = 0;
  const skipReasons: Record<string, number> = {};
  const recent: WatchConnectStats["recent"] = [];

  for (const r of records) {
    if (r.status === "skipped") {
      skipped++;
      const reason = r.skipReason ?? "unknown";
      skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    } else {
      requested++;
    }
    const action = r.actionId ? byAction.get(r.actionId) : undefined;
    const wasSent = action?.status === "success";
    if (wasSent) sent++;
    let wasAccepted = false;
    if (wasSent && r.personIdentityId) {
      const identity = await getIdentity(workspaceId, r.personIdentityId);
      if (identity?.connectedAt && identity.connectedAt >= r.watchedAt) {
        accepted++;
        wasAccepted = true;
      }
    }
    const p = await core.getProspect(r.prospectId);
    if (wasSent && p && (p.status === "booked" || p.status === "won" || p.bookedAt)) {
      meetings++;
    }
    recent.push({
      prospectName: p?.fullName || p?.email,
      recruiterName: r.recruiterName,
      watchedAt: r.watchedAt,
      status: r.status === "skipped"
        ? "skipped: " + (r.skipReason ?? "unknown")
        : wasAccepted ? "accepted" : wasSent ? "sent" : "queued",
    });
  }
  recent.sort((a, b) => (a.watchedAt < b.watchedAt ? 1 : -1));
  recent.splice(12);

  return { watched: records.length, requested, sent, accepted, meetings, skipped, skipReasons, recent };
}
