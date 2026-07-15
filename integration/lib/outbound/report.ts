/**
 * RecruitersOS · Outbound Performance · report exports (CSV)
 *
 * Excel opens CSV natively, so CSV covers both requested spreadsheet formats;
 * the existing reporting architecture has no PDF renderer, so PDF is not
 * offered rather than faked.
 */

import { listMembers } from "../auth/team";
import { teamOverview, userProfile } from "./index";
import { listRollups, workspaceTz } from "./rollup";
import { localDay } from "./goals";
import type { DayCounts } from "./types";

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const COUNT_COLS: Array<[keyof DayCounts, string]> = [
  ["bdEmailsSent", "BD emails"],
  ["recruitingEmailsSent", "Recruiting emails"],
  ["liConnectionsSent", "LI connections"],
  ["liConnectionsAccepted", "LI accepts"],
  ["liMessagesSent", "LI messages"],
  ["liVoiceNotes", "LI voice notes"],
  ["liInMails", "LI InMails"],
  ["liProfileViews", "LI profile views"],
  ["liPostsPublished", "LI posts"],
  ["smsSent", "SMS sent"],
  ["smsReceived", "SMS received"],
  ["smsOptOuts", "SMS opt-outs"],
  ["voiceTouches", "Voice touches"],
  ["followUpsCompleted", "Follow-ups"],
  ["repliesReceived", "Replies"],
  ["positiveReplies", "Positive replies"],
  ["meetingsBooked", "Meetings"],
  ["candidateConversations", "Candidate conversations"],
  ["bdConversations", "BD conversations"],
];

export async function teamCsv(workspaceId: string): Promise<string> {
  const t = await teamOverview(workspaceId);
  const head = ["User", "Email", "Role", "Goal role", "Outbound score", "Status", "Overall %", "Email %", "LinkedIn %", "SMS %", "Content %", "Follow-up %", "Positive", "Meetings", "Supply constrained", "System issues", "Last login"];
  const rows = t.rows.map((r) => [
    r.name, r.email, r.authRole, r.goalRole, r.score, r.statusLine, r.overallPct,
    r.emailPct, r.linkedinPct < 0 ? "n/a" : r.linkedinPct, r.smsPct < 0 ? "n/a" : r.smsPct,
    r.contentPct < 0 ? "n/a" : r.contentPct, r.followUpPct, r.positive, r.meetings,
    r.supplyConstrained ? "yes" : "no", r.systemIssues, r.lastLogin ?? "",
  ]);
  return csv([head, ...rows]);
}

export async function userCsv(workspaceId: string, userId: string, sinceDays = 30): Promise<string> {
  const p = await userProfile(workspaceId, userId, sinceDays);
  const tz = await workspaceTz(workspaceId);
  const since = localDay(tz, new Date(Date.now() - (sinceDays - 1) * 86_400_000));
  const rows = await listRollups(workspaceId, { userId, sinceDay: since });
  const head = ["Day", ...COUNT_COLS.map(([, label]) => label)];
  const body = rows.map((r) => [r.day, ...COUNT_COLS.map(([k]) => r.counts[k] ?? 0)]);
  return csv([["User", p.name, "Score", p.score.total, "Status", p.score.statusLine], [], head, ...body]);
}

export async function channelsCsv(workspaceId: string): Promise<string> {
  const t = await teamOverview(workspaceId);
  const head = ["Channel", "Team utilization %"];
  return csv([
    head,
    ["Email", t.totals.emailPct],
    ["LinkedIn", t.totals.linkedinPct],
    ["SMS", t.totals.smsPct],
    ["LinkedIn content compliance", t.totals.contentCompliancePct],
    ["Follow-up completion", t.totals.followUpCompliancePct],
  ]);
}

export async function historyCsv(workspaceId: string, sinceDays = 90): Promise<string> {
  const tz = await workspaceTz(workspaceId);
  const since = localDay(tz, new Date(Date.now() - (sinceDays - 1) * 86_400_000));
  const rows = await listRollups(workspaceId, { sinceDay: since });
  const names = new Map(listMembers(workspaceId).map((m) => [m.userId, m.name || m.email]));
  const head = ["Day", "User", ...COUNT_COLS.map(([, label]) => label)];
  const body = rows.map((r) => [
    r.day, r.userId ? (names.get(r.userId) ?? r.userId) : "(unattributed)",
    ...COUNT_COLS.map(([k]) => r.counts[k] ?? 0),
  ]);
  return csv([head, ...body]);
}
