/**
 * RecruitersOS · Outbound Performance · Capacity Utilization Engine
 *
 * "How much safe outreach could this user do today, how much did they do,
 * and if the gap is not their fault, whose is it?" Every channel resolves to
 * a ChannelUtilization with used / target / capacity / state / reasons, and
 * SUPPLY is checked before anyone is blamed: available capacity with no
 * contacts queued is a supply constraint, not underutilization.
 *
 * Sources: sender pools (hard cold caps), LinkedIn OS policies x health,
 * campaign queues, sending-domain metrics, goals (goals.ts), today's rollup.
 */

import { getCore } from "../core/repository";
import { getDay, listRollups, workspaceTz } from "./rollup";
import { localDay, localHour, resolveGoals } from "./goals";
import type {
  ChannelState, ChannelUtilization, ResolvedGoals, SupplyView, SystemFactor,
  UserCapacity, UserDayRollup,
} from "./types";

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

function classify(used: number, target: number, capacity: number, enabled: boolean): ChannelState {
  if (!enabled) return "not_enabled";
  if (target <= 0) return "not_enabled";
  const p = pct(used, target);
  if (p >= 85) return "strong";
  if (p >= 55) return "attention";
  return "underutilized";
}

function util(
  key: ChannelUtilization["key"], label: string,
  used: number, target: number, capacity: number,
  enabled: boolean, reasons: string[], action?: string,
): ChannelUtilization {
  const state = classify(used, target, capacity, enabled);
  return {
    key, label, used, target, capacity,
    remaining: Math.max(0, capacity - used),
    utilizationPct: pct(used, capacity),
    targetPct: pct(used, target),
    state, reasons,
    // A channel the user cannot act on never carries a to-do.
    recommendedAction: state === "not_enabled" ? undefined : action,
  };
}

/* ------------------------------ supply ---------------------------------- */

export async function campaignSupply(workspaceId: string, userId: string): Promise<SupplyView> {
  const core = getCore();
  const [campaigns, prospects] = await Promise.all([
    core.listCampaigns(workspaceId),
    core.listProspects(workspaceId),
  ]);
  const active = campaigns.filter((c) => c.status === "active");
  const mineOrShared = (cid?: string, ownerId?: string) => {
    if (ownerId && ownerId !== userId) return false;
    if (ownerId === userId) return true;
    const c = cid ? active.find((x) => x.id === cid) : undefined;
    return !c?.recruiterId || c.recruiterId === userId;
  };
  const activeIds = new Set(active.map((c) => c.id));
  const queued = prospects.filter((p) =>
    p.status === "queued" && p.campaignId && activeIds.has(p.campaignId) && mineOrShared(p.campaignId, p.ownerId),
  );
  // "Ready" = queued AND not on a data hold (verified-email gate only applies
  // to Send Queue campaigns; a missing email is a hold for email outreach).
  const ready = queued.filter((p) => !p.copyHold && (!!p.email || !!p.linkedinUrl || !!p.phone));
  const myActive = active.filter((c) => !c.recruiterId || c.recruiterId === userId);
  return {
    contactsReady: ready.length,
    queuedTotal: queued.length,
    activeCampaigns: myActive.length,
    constrained: false, // finalized by the caller against remaining capacity
    detail: `${ready.length} contacts ready across ${myActive.length} active campaign${myActive.length === 1 ? "" : "s"}`,
  };
}

/* --------------------------- follow-up dues ----------------------------- */

/** Prospects owned by (or assigned via campaign to) the user whose next
 *  modeled touch is due but unsent. */
export async function followUpsDue(workspaceId: string, userId: string): Promise<number> {
  const core = getCore();
  const [campaigns, prospects] = await Promise.all([
    core.listCampaigns(workspaceId),
    core.listProspects(workspaceId),
  ]);
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  let due = 0;
  const now = Date.now();
  for (const p of prospects) {
    if (p.status !== "in_sequence" || !p.sequenceStartedAt) continue;
    const c = p.campaignId ? byId.get(p.campaignId) : undefined;
    const owner = p.ownerId || c?.recruiterId;
    if (owner && owner !== userId) continue;
    if (!owner && c?.recruiterId && c.recruiterId !== userId) continue;
    const touches = c?.model?.touches ?? [];
    if (!touches.length) continue;
    const daysSince = (now - Date.parse(p.sequenceStartedAt)) / 86_400_000;
    const dueTouches = touches.filter((t) => (t.day ?? 0) <= daysSince).length;
    const sent = p.dripStage ?? 0;
    if (dueTouches > sent) due += 1;
  }
  return due;
}

/* -------------------------- response backlog ---------------------------- */

export interface ResponseBacklog {
  linkedinNeedsAttention: number;
  smsAwaitingReply: number;
  oldestWaitMinutes: number | null;
}

export async function responseBacklog(workspaceId: string, userId: string): Promise<ResponseBacklog> {
  let linkedinNeedsAttention = 0;
  let smsAwaitingReply = 0;
  let oldestMs: number | null = null;

  try {
    const { listConversations } = await import("../linkedin/os/inbox");
    const convos = await listConversations(workspaceId);
    for (const c of convos) {
      if ((c as { needsAttention?: boolean }).needsAttention) linkedinNeedsAttention++;
    }
  } catch { /* LinkedIn inbox unavailable */ }

  try {
    const { recentResponses } = await import("../response");
    const core = getCore();
    const prospects = await core.listProspects(workspaceId);
    const pById = new Map(prospects.map((p) => [p.id, p]));
    const activity = await core.listAllActivity(workspaceId);
    const responses = await recentResponses(workspaceId, 2000);
    const cutoff = Date.now() - 7 * 86_400_000;
    for (const r of responses) {
      if ((r.inbound.channel || "") !== "sms") continue;
      const at = Date.parse(r.inbound.receivedAt);
      if (!Number.isFinite(at) || at < cutoff) continue;
      const pid = r.inbound.prospectId;
      if (!pid) continue;
      const p = pById.get(pid);
      const owner = p?.ownerId;
      if (owner && owner !== userId) continue;
      if (r.classification.class === "stop" || r.classification.class === "not_interested") continue;
      // Answered when any outbound SMS to this prospect follows the reply.
      const answered = activity.some((e) =>
        e.prospectId === pid && e.channel === "sms" && e.type.endsWith("_sent") && Date.parse(e.at) > at,
      );
      if (!answered) {
        smsAwaitingReply++;
        if (oldestMs === null || at < oldestMs) oldestMs = at;
      }
    }
  } catch { /* response pipeline unavailable */ }

  return {
    linkedinNeedsAttention,
    smsAwaitingReply,
    oldestWaitMinutes: oldestMs === null ? null : Math.round((Date.now() - oldestMs) / 60_000),
  };
}

/* ------------------------- the per-user engine --------------------------- */

export interface CapacityContext {
  goals: ResolvedGoals;
  today: UserDayRollup;
  weekRollups: UserDayRollup[];
}

export async function userCapacity(workspaceId: string, userId: string, authRole = "member"): Promise<UserCapacity & { ctx: CapacityContext }> {
  const tz = await workspaceTz(workspaceId);
  const today = localDay(tz);
  const goals = await resolveGoals(workspaceId, userId, authRole);
  const dayRoll = await getDay(workspaceId, userId, today);
  const weekAgo = localDay(tz, new Date(Date.now() - 6 * 86_400_000));
  const weekRollups = await listRollups(workspaceId, { userId, sinceDay: weekAgo, untilDay: today });
  const factors: SystemFactor[] = [];
  const c = dayRoll.counts;

  /* --------------------------- email ------------------------------------ */
  let emailCapacity = 0;
  let emailReasons: string[] = [];
  let poolInboxes = 0;
  try {
    const { sendCapacity } = await import("../senders/store");
    const cap = await sendCapacity(workspaceId);
    const mine = cap.byRecruiter.find((r) => r.ownerId === userId);
    if (mine) {
      emailCapacity = mine.coldCapacity;
      poolInboxes = mine.inboxes;
      emailReasons.push(`${mine.inboxes} connected mailbox${mine.inboxes === 1 ? "" : "es"} x ${cap.coldPerInbox}/day safe cold cap = ${mine.coldCapacity} emails`);
    }
    const unassigned = cap.byRecruiter.find((r) => !r.ownerId);
    if (unassigned && unassigned.coldCapacity > 0) {
      emailReasons.push(`${unassigned.coldCapacity} additional shared (unassigned) mailbox capacity in the pool`);
    }
    const { listInboxes } = await import("../senders/store");
    const inboxes = await listInboxes(workspaceId, { ownerId: userId });
    const broken = inboxes.filter((m) => m.status === "error" || m.status === "paused");
    if (broken.length) {
      factors.push({ scope: "email", severity: "warn", reason: `${broken.length} mailbox${broken.length === 1 ? "" : "es"} paused or in error (${broken.map((b) => b.email).slice(0, 3).join(", ")})` });
    }
  } catch { /* senders module unavailable */ }
  const emailTarget = (goals.channels.bdEmails.target || 0) + (goals.channels.recruitingEmails.target || 0);
  if (goals.emailPool?.applied) {
    emailReasons.unshift(
      `Team pool: ${goals.emailPool.total.toLocaleString()} first emails/day split across ${goals.emailPool.recruiterCount} recruiter${goals.emailPool.recruiterCount === 1 ? "" : "s"} = ${goals.emailPool.perRecruiter.toLocaleString()} each (recomputed as the roster changes)`,
    );
  }
  if (!emailCapacity) {
    emailCapacity = (goals.channels.bdEmails.max || 0) + (goals.channels.recruitingEmails.max || 0);
    if (poolInboxes === 0) emailReasons.push("no personal mailbox pool; capacity shown from role goals (sends route via the shared pool/MTA)");
  }
  const emailUsed = c.bdEmailsSent + c.recruitingEmailsSent;
  const emailEnabled = emailTarget > 0;
  const emailGap = Math.max(0, emailTarget - emailUsed);
  const email = util(
    "email", "Email", emailUsed, emailTarget, Math.max(emailCapacity, emailTarget), emailEnabled, emailReasons,
    emailGap > 0 ? `Send ${emailGap} additional targeted email${emailGap === 1 ? "" : "s"} today.` : undefined,
  );

  // Deliverability guard rails feed system factors, not blame.
  try {
    const { listDomains } = await import("../sending/store");
    const domains = await listDomains(workspaceId);
    for (const d of domains) {
      const m = d.metrics;
      if (!m || !m.sent) continue;
      const bounce = pct(m.bounced, m.sent);
      const spam = pct(m.complained, m.delivered || m.sent);
      if (bounce > goals.triggers.bounceRatePct) {
        factors.push({ scope: "email", severity: "critical", reason: `Domain ${d.domain} bounce rate ${bounce}% exceeds the ${goals.triggers.bounceRatePct}% threshold` });
      } else if (spam > 0.3) {
        factors.push({ scope: "email", severity: "warn", reason: `Domain ${d.domain} spam-complaint rate ${spam}%` });
      }
    }
  } catch { /* sending infra optional */ }

  /* -------------------------- linkedin ---------------------------------- */
  let liCapacity = 0;
  let liEffectiveTarget = 0;
  let liEnabled = false;
  const liReasons: string[] = [];
  try {
    const { listAccounts, capacityFactor } = await import("../linkedin/os/health");
    const { getPolicy } = await import("../linkedin/os/policy");
    const { listLedger, utilizationFor, policyDay } = await import("../linkedin/os/ledger");
    const accounts = await listAccounts(workspaceId);
    const relevant = accounts.filter((a) => !a.ownerUserId || a.ownerUserId === userId);
    if (relevant.length) {
      liEnabled = true;
      const all = await listLedger(workspaceId);
      for (const a of relevant) {
        const policy = await getPolicy(workspaceId, a.accountId);
        const f = capacityFactor(a);
        const day = policyDay(policy.timezone || tz);
        const cats = utilizationFor(all, policy, a.accountId, day, f);
        for (const cat of cats) {
          if (cat.category === "interactions") continue;
          liEffectiveTarget += cat.effectiveTarget;
          liCapacity += Math.floor(cat.hardCeiling * (f || 0));
        }
        if (!a.connected) factors.push({ scope: "linkedin", severity: "critical", reason: `LinkedIn account "${a.displayName}" is disconnected` });
        else if (a.killSwitch) factors.push({ scope: "linkedin", severity: "critical", reason: `LinkedIn account "${a.displayName}" kill switch is on` });
        else if (f === 0) factors.push({ scope: "linkedin", severity: "critical", reason: `LinkedIn account "${a.displayName}" is ${a.health} (automation stopped)` });
        else if (f < 1) factors.push({ scope: "linkedin", severity: "warn", reason: `LinkedIn account "${a.displayName}" health is ${a.health}; capacity reduced to ${Math.round(f * 100)}%` });
        liReasons.push(`Account "${a.displayName}": shared across recruiting + BD; policy targets x health set today's safe capacity`);
      }
    } else {
      liReasons.push("No LinkedIn account connected for this user");
    }
  } catch { liReasons.push("LinkedIn OS unavailable in this build"); }

  const liGoalTarget = goals.channels.liConnections.target + goals.channels.liMessages.target
    + goals.channels.liVoiceNotes.target + goals.channels.liProfileViews.target;
  const liTarget = liEnabled && liEffectiveTarget > 0 ? Math.min(liGoalTarget || liEffectiveTarget, liEffectiveTarget) : liGoalTarget;
  const liUsed = c.liConnectionsSent + c.liMessagesSent + c.liVoiceNotes + c.liInMails + c.liProfileViews;
  const liGap = Math.max(0, liTarget - liUsed);
  const linkedin = util(
    "linkedin", "LinkedIn", liUsed, liTarget, Math.max(liCapacity, liTarget), liEnabled && liTarget > 0, liReasons,
    liGap > 0 ? `Complete ${liGap} more LinkedIn action${liGap === 1 ? "" : "s"} today (connections, messages, profile views).` : undefined,
  );
  if (liEnabled && liCapacity === 0) linkedin.state = "system_limited";

  /* ----------------------------- sms ------------------------------------ */
  const smsProviderReady = !!(process.env.TELNYX_API_KEY || process.env.TALTXT_API_KEY);
  const smsTarget = goals.channels.smsMessages.target;
  const smsEnabled = smsProviderReady && smsTarget > 0;
  const smsUsed = c.smsSent;
  const smsGap = Math.max(0, smsTarget - smsUsed);
  const smsReasons: string[] = [];
  if (!smsProviderReady) {
    smsReasons.push("No SMS provider configured (Telnyx / OS Text)");
    factors.push({ scope: "sms", severity: "info", reason: "SMS is not configured for this workspace (Telnyx / OS Text key missing)" });
  } else {
    smsReasons.push(`Daily SMS goal band ${goals.channels.smsMessages.min}-${goals.channels.smsMessages.max}; recruiting motion only (BD SMS is blocked by policy)`);
  }
  const sms = util(
    "sms", "SMS", smsUsed, smsTarget, Math.max(goals.channels.smsMessages.max, smsTarget), smsEnabled, smsReasons,
    smsEnabled && smsGap > 0 ? `Send ${smsGap} more recruiting SMS today.` : undefined,
  );

  /* --------------------------- follow-ups --------------------------------
     Discipline = clearing what is DUE, not hitting a raw count. The day's
     workload is completed + still-due; nothing due means the user is current. */
  const due = await followUpsDue(workspaceId, userId);
  const fuUsed = c.followUpsCompleted;
  const fuWorkload = fuUsed + due;
  const followUp = util(
    "followUp", "Follow-ups", fuUsed, fuWorkload, fuWorkload, fuWorkload > 0,
    due > 0 ? [`${due} prospect${due === 1 ? "" : "s"} have a sequence touch due and unsent`] : ["All modeled sequence touches are current"],
    due > 0 ? `Complete the next follow-up step for ${due} prospect${due === 1 ? "" : "s"}.` : undefined,
  );
  if (fuWorkload > 0) followUp.state = due === 0 ? "strong" : fuUsed > 0 ? "attention" : "underutilized";
  else { followUp.state = "strong"; followUp.utilizationPct = 100; followUp.targetPct = 100; }

  /* ----------------------------- content --------------------------------- */
  const postsThisWeek = weekRollups.reduce((s, r) => s + (r.counts.liPostsPublished || 0), 0);
  const postTarget = goals.channels.liPostsPerWeek.target;
  const postGap = Math.max(0, postTarget - postsThisWeek);
  const content = util(
    "content", "LinkedIn content", postsThisWeek, postTarget, Math.max(goals.channels.liPostsPerWeek.max, postTarget), postTarget > 0,
    [`${postsThisWeek} post${postsThisWeek === 1 ? "" : "s"} published in the last 7 days (goal ${postTarget}/week)`],
    postGap > 0 ? `Publish ${postGap} LinkedIn post${postGap === 1 ? "" : "s"} this week.` : undefined,
  );

  /* ----------------------------- response -------------------------------- */
  const backlog = await responseBacklog(workspaceId, userId);
  const pending = backlog.linkedinNeedsAttention + backlog.smsAwaitingReply;
  const respReasons: string[] = [];
  if (backlog.smsAwaitingReply) respReasons.push(`${backlog.smsAwaitingReply} SMS conversation${backlog.smsAwaitingReply === 1 ? "" : "s"} awaiting a reply`);
  if (backlog.linkedinNeedsAttention) respReasons.push(`${backlog.linkedinNeedsAttention} LinkedIn conversation${backlog.linkedinNeedsAttention === 1 ? "" : "s"} need attention`);
  if (backlog.oldestWaitMinutes && backlog.oldestWaitMinutes > goals.triggers.smsReplyWaitMinutes) {
    const h = Math.floor(backlog.oldestWaitMinutes / 60), m = backlog.oldestWaitMinutes % 60;
    respReasons.push(`Oldest waiting reply: ${h ? h + "h " : ""}${m}m (team target under ${goals.triggers.smsReplyWaitMinutes}m)`);
  }
  if (!respReasons.length) respReasons.push("No conversations waiting");
  const response: ChannelUtilization = {
    key: "response", label: "Response management",
    used: c.repliesReceived, target: 0, capacity: 0,
    remaining: pending,
    utilizationPct: pending === 0 ? 100 : Math.max(0, 100 - pending * 10),
    targetPct: pending === 0 ? 100 : Math.max(0, 100 - pending * 10),
    state: pending === 0 ? "strong" : pending <= 3 ? "attention" : "underutilized",
    reasons: respReasons,
    recommendedAction: pending > 0 ? `Respond to ${pending} waiting conversation${pending === 1 ? "" : "s"}.` : undefined,
  };

  /* ------------------------------ supply --------------------------------- */
  const supply = await campaignSupply(workspaceId, userId);
  const outboundRemaining = email.remaining + linkedin.remaining + (smsEnabled ? sms.remaining : 0);
  supply.constrained = supply.contactsReady < Math.min(outboundRemaining, emailTarget) && outboundRemaining > 0;
  if (supply.activeCampaigns === 0) {
    factors.push({ scope: "global", severity: "critical", reason: "No active campaigns assigned; outbound capacity cannot be spent" });
  } else if (supply.constrained) {
    factors.push({
      scope: "global", severity: "warn",
      reason: `Outreach supply constraint: ${outboundRemaining} outbound actions of capacity remain but only ${supply.contactsReady} contacts are ready in active campaigns`,
    });
  }
  try {
    const { automationEnabled } = await import("../automation/scheduler");
    if (!automationEnabled()) {
      factors.push({ scope: "global", severity: "warn", reason: "AUTOMATION_ENABLED is off: scheduled sends, autopilot, and reminders are not running" });
    }
  } catch { /* scheduler introspection optional */ }

  // Supply constraint re-labels channel blame.
  if (supply.constrained) {
    for (const ch of [email, linkedin, sms]) {
      if (ch.state === "underutilized") {
        ch.state = "supply_constrained";
        ch.recommendedAction = "Ask an admin to add contacts to an active campaign (capacity exceeds ready supply).";
      }
    }
  }

  const enabledChannels = [email, linkedin, sms].filter((x) => x.state !== "not_enabled");
  const overallUsed = enabledChannels.reduce((s, x) => s + x.used, 0);
  const overallCap = enabledChannels.reduce((s, x) => s + Math.max(x.capacity, x.target), 0);

  return {
    userId,
    email, linkedin, sms, followUp, content, response,
    supply,
    systemFactors: factors,
    overallPct: pct(overallUsed, overallCap),
    ctx: { goals, today: dayRoll, weekRollups },
  };
}

/** Hour-aware pace estimate for the midday warning: expected share of the
 *  day's target completed by `hour` within working hours. */
export function expectedPaceByHour(goals: ResolvedGoals, hour: number): number {
  const start = goals.workHoursStart, end = goals.workHoursEnd;
  if (hour <= start) return 0;
  if (hour >= end) return 1;
  return (hour - start) / Math.max(1, end - start);
}

export { localHour };
