/**
 * RecruitersOS · Outbound Performance · composite read models + barrel
 *
 * userProfile() = everything the admin's user drill-down and the user's own
 * "My Outbound" view need in one call; teamOverview() = the ranked table,
 * heatmap and KPI strip for the Outbound Performance dashboard.
 */

import { devAuthStore } from "../auth";
import { listMembers } from "../auth/team";
import { getCore } from "../core/repository";
import { userCapacity } from "./capacity";
import { getDay, listRollups, sumCounts, workspaceTz } from "./rollup";
import { computeScore, SCORE_METHODOLOGY, SCORE_WEIGHTS } from "./score";
import { localDay } from "./goals";
import { listAlerts } from "./triggers";
import type { ChannelState, DayCounts, OutboundAlert, OutboundScore, UserCapacity, UserDayRollup } from "./types";

export * from "./types";
export { resolveGoals, getGoalsConfig, putGoalsConfig, emailPoolSplit, GOAL_ROLES, DEFAULT_CHANNELS, DEFAULT_TRIGGERS, localDay } from "./goals";
export { collectOutboundEvents } from "./events";
export { listRollups, getDay, refreshRollups, sumCounts, workspaceTz } from "./rollup";
export { userCapacity, campaignSupply, followUpsDue, responseBacklog } from "./capacity";
export { computeScore, SCORE_METHODOLOGY, SCORE_WEIGHTS } from "./score";
export { evaluateTriggers, listAlerts, markAlertRead } from "./triggers";
export {
  getPrefs, setPrefs, listNotifications, markNotificationRead, pushNotification,
  buildMorning, buildMidday, buildEod, alreadySent, markSent,
} from "./notify";
export { userAssessment, adminInsights } from "./insights";
export { buildChecklist, setStepTick } from "./checklist";
export { appendAudit, listAudit } from "./audit";
export { notifyBrand } from "./brand";
export type { NotifyBrand } from "./brand";

/* ------------------------------ profile ---------------------------------- */

function lastLoginOf(userId: string): string | null {
  try {
    const store = devAuthStore();
    let latest: string | null = null;
    for (const s of store.sessions.values()) {
      if (s.userId === userId && (!latest || s.createdAt > latest)) latest = s.createdAt;
    }
    return latest;
  } catch { return null; }
}

export interface TrendPoint { day: string; sends: number; replies: number; positive: number; meetings: number; posts: number; }

function trendFrom(rows: UserDayRollup[]): TrendPoint[] {
  const byDay = new Map<string, TrendPoint>();
  for (const r of rows) {
    const t = byDay.get(r.day) ?? { day: r.day, sends: 0, replies: 0, positive: 0, meetings: 0, posts: 0 };
    const c = r.counts;
    t.sends += c.bdEmailsSent + c.recruitingEmailsSent + c.liConnectionsSent + c.liMessagesSent + c.liVoiceNotes + c.liInMails + c.smsSent + c.voiceTouches;
    t.replies += c.repliesReceived + c.smsReceived;
    t.positive += c.positiveReplies;
    t.meetings += c.meetingsBooked;
    t.posts += c.liPostsPublished;
    byDay.set(r.day, t);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export interface UserProfile {
  userId: string;
  name: string;
  email: string;
  authRole: string;
  goalRole: string;
  lastLogin: string | null;
  activeCampaigns: Array<{ id: string; name: string; motion: string; status: string }>;
  capacity: UserCapacity;
  score: OutboundScore;
  today: DayCounts;
  trend: TrendPoint[];
  baseline: { recentAvgSends: number; priorAvgSends: number; deltaPct: number | null };
  alerts: OutboundAlert[];
}

export async function userProfile(workspaceId: string, userId: string, sinceDays = 30): Promise<UserProfile> {
  const tz = await workspaceTz(workspaceId);
  const today = localDay(tz);
  const member = listMembers(workspaceId).find((m) => m.userId === userId);
  const cap = await userCapacity(workspaceId, userId, member?.role ?? "member");
  const todayRoll = await getDay(workspaceId, userId, today);
  const score = computeScore(cap, {
    positiveReplies: todayRoll.counts.positiveReplies,
    meetingsBooked: todayRoll.counts.meetingsBooked,
  });

  const since = localDay(tz, new Date(Date.now() - (sinceDays - 1) * 86_400_000));
  const rows = await listRollups(workspaceId, { userId, sinceDay: since });
  const trend = trendFrom(rows);

  // Personal baseline: trailing 7d vs the 30d before that.
  const d7 = localDay(tz, new Date(Date.now() - 7 * 86_400_000));
  const d37 = localDay(tz, new Date(Date.now() - 37 * 86_400_000));
  const recent = trendFrom(await listRollups(workspaceId, { userId, sinceDay: d7 }));
  const prior = trendFrom(await listRollups(workspaceId, { userId, sinceDay: d37, untilDay: d7 }));
  const avg = (pts: TrendPoint[]) => (pts.length ? pts.reduce((s, p) => s + p.sends, 0) / pts.length : 0);
  const recentAvg = avg(recent);
  const priorAvg = avg(prior);

  const core = getCore();
  const campaigns = await core.listCampaigns(workspaceId);
  const activeCampaigns = campaigns
    .filter((c) => c.status === "active" && (!c.recruiterId || c.recruiterId === userId))
    .map((c) => ({ id: c.id, name: c.name, motion: c.motion, status: c.status }));

  const alerts = await listAlerts(workspaceId, { userId, limit: 30 });

  return {
    userId,
    name: member?.name ?? "(unknown)",
    email: member?.email ?? "",
    authRole: member?.role ?? "member",
    goalRole: cap.ctx.goals.role,
    lastLogin: lastLoginOf(userId),
    activeCampaigns,
    capacity: cap,
    score,
    today: todayRoll.counts,
    trend,
    baseline: {
      recentAvgSends: Math.round(recentAvg * 10) / 10,
      priorAvgSends: Math.round(priorAvg * 10) / 10,
      deltaPct: priorAvg > 0 ? Math.round(((recentAvg - priorAvg) / priorAvg) * 100) : null,
    },
    alerts,
  };
}

/* ---------------------------- team overview ------------------------------ */

export interface TeamRow {
  userId: string;
  name: string;
  email: string;
  authRole: string;
  goalRole: string;
  score: number;
  statusLine: string;
  overallPct: number;
  emailPct: number;
  linkedinPct: number;
  smsPct: number;
  contentPct: number;
  followUpPct: number;
  positive: number;
  meetings: number;
  lastLogin: string | null;
  activeToday: boolean;
  heat: Record<string, { state: ChannelState | "ok"; pct: number; detail: string }>;
  supplyConstrained: boolean;
  systemIssues: number;
}

export interface TeamOverview {
  generatedAt: string;
  day: string;
  totals: {
    users: number;
    activeToday: number;
    outboundToday: number;
    overallPct: number;
    emailPct: number;
    linkedinPct: number;
    smsPct: number;
    contentCompliancePct: number;
    followUpCompliancePct: number;
    openConversations: number;
    positive: number;
    meetings: number;
    candidateConversations: number;
    bdConversations: number;
  };
  rows: TeamRow[];
  unattributed: DayCounts;
  methodology: string[];
  weights: Record<string, number>;
}

export async function teamOverview(workspaceId: string): Promise<TeamOverview> {
  const tz = await workspaceTz(workspaceId);
  const day = localDay(tz);
  const members = listMembers(workspaceId);
  const rows: TeamRow[] = [];
  let usedSum = 0, capSum = 0;
  const chanAgg = { email: { u: 0, t: 0 }, linkedin: { u: 0, t: 0 }, sms: { u: 0, t: 0 } };
  let contentOk = 0, contentApplicable = 0, fuOk = 0, fuApplicable = 0, openConvos = 0;
  const teamToday = { outbound: 0, positive: 0, meetings: 0, cand: 0, bd: 0 };

  for (const m of members) {
    let cap;
    try { cap = await userCapacity(workspaceId, m.userId, m.role); } catch { continue; }
    const todayRoll = await getDay(workspaceId, m.userId, day);
    const c = todayRoll.counts;
    const score = computeScore(cap, { positiveReplies: c.positiveReplies, meetingsBooked: c.meetingsBooked });
    const sends = c.bdEmailsSent + c.recruitingEmailsSent + c.liConnectionsSent + c.liMessagesSent + c.liVoiceNotes + c.liInMails + c.smsSent + c.voiceTouches;

    const pctOf = (u: { used: number; target: number }) => (u.target > 0 ? Math.min(999, Math.round((u.used / u.target) * 100)) : 0);
    const heatCell = (u: { state: ChannelState; targetPct: number; used: number; target: number; reasons: string[]; recommendedAction?: string }) => ({
      state: u.state as ChannelState | "ok",
      pct: Math.round(u.targetPct),
      detail: [`${u.used}/${u.target} today (${u.targetPct}% of target)`, ...u.reasons, u.recommendedAction || ""].filter(Boolean).join(" · "),
    });

    rows.push({
      userId: m.userId,
      name: m.name || m.email,
      email: m.email,
      authRole: m.role,
      goalRole: cap.ctx.goals.role,
      score: score.total,
      statusLine: score.statusLine,
      overallPct: cap.overallPct,
      emailPct: pctOf(cap.email),
      linkedinPct: pctOf(cap.linkedin),
      smsPct: cap.sms.state === "not_enabled" ? -1 : pctOf(cap.sms),
      contentPct: cap.content.state === "not_enabled" ? -1 : pctOf(cap.content),
      followUpPct: Math.round(cap.followUp.targetPct),
      positive: c.positiveReplies,
      meetings: c.meetingsBooked,
      lastLogin: lastLoginOf(m.userId),
      activeToday: sends > 0,
      heat: {
        email: heatCell(cap.email),
        linkedin: heatCell(cap.linkedin),
        sms: cap.sms.state === "not_enabled" ? { state: "not_enabled", pct: 0, detail: "SMS not enabled for this workspace/user" } : heatCell(cap.sms),
        followUp: heatCell(cap.followUp),
        content: cap.content.state === "not_enabled" ? { state: "not_enabled", pct: 0, detail: "No posting goal configured" } : heatCell(cap.content),
        response: { state: cap.response.state, pct: Math.round(cap.response.targetPct), detail: cap.response.reasons.join(" · ") },
        meetings: { state: c.meetingsBooked > 0 ? "strong" : "ok", pct: c.meetingsBooked, detail: `${c.meetingsBooked} meeting${c.meetingsBooked === 1 ? "" : "s"} booked today` },
      },
      supplyConstrained: cap.supply.constrained,
      systemIssues: cap.systemFactors.filter((f) => f.severity !== "info").length,
    });

    const enabled = [cap.email, cap.linkedin, cap.sms].filter((x) => x.state !== "not_enabled");
    usedSum += enabled.reduce((s, x) => s + x.used, 0);
    capSum += enabled.reduce((s, x) => s + Math.max(x.capacity, x.target), 0);
    if (cap.email.state !== "not_enabled") { chanAgg.email.u += cap.email.used; chanAgg.email.t += cap.email.target; }
    if (cap.linkedin.state !== "not_enabled") { chanAgg.linkedin.u += cap.linkedin.used; chanAgg.linkedin.t += cap.linkedin.target; }
    if (cap.sms.state !== "not_enabled") { chanAgg.sms.u += cap.sms.used; chanAgg.sms.t += cap.sms.target; }
    if (cap.content.state !== "not_enabled") { contentApplicable++; if (cap.content.used >= cap.content.target) contentOk++; }
    if (cap.followUp.target > 0 || cap.followUp.remaining > 0) { fuApplicable++; if (cap.followUp.remaining === 0) fuOk++; }
    openConvos += cap.response.remaining;
    teamToday.outbound += sends;
    teamToday.positive += c.positiveReplies;
    teamToday.meetings += c.meetingsBooked;
    teamToday.cand += c.candidateConversations;
    teamToday.bd += c.bdConversations;
  }

  rows.sort((a, b) => b.score - a.score);
  const unattributedRows = await listRollups(workspaceId, { userId: "", sinceDay: day, untilDay: day });
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

  return {
    generatedAt: new Date().toISOString(),
    day,
    totals: {
      users: members.length,
      activeToday: rows.filter((r) => r.activeToday).length,
      outboundToday: teamToday.outbound,
      overallPct: pct(usedSum, capSum),
      emailPct: pct(chanAgg.email.u, chanAgg.email.t),
      linkedinPct: pct(chanAgg.linkedin.u, chanAgg.linkedin.t),
      smsPct: pct(chanAgg.sms.u, chanAgg.sms.t),
      contentCompliancePct: pct(contentOk, contentApplicable),
      followUpCompliancePct: pct(fuOk, fuApplicable),
      openConversations: openConvos,
      positive: teamToday.positive,
      meetings: teamToday.meetings,
      candidateConversations: teamToday.cand,
      bdConversations: teamToday.bd,
    },
    rows,
    unattributed: sumCounts(unattributedRows),
    methodology: SCORE_METHODOLOGY,
    weights: SCORE_WEIGHTS,
  };
}
