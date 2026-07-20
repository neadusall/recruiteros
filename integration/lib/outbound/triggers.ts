/**
 * RecruitersOS · Outbound Performance · trigger engine
 *
 * Not scheduled reports: CONDITIONS. Each trigger inspects a user's live
 * numbers (capacity engine + rollups + baselines) against the resolved
 * thresholds and emits alerts with a severity and an audience. Alerts are
 * deduped per user/kind/day so a condition fires once, not every tick.
 *
 * Severities: warning | critical | opportunity | achievement | info.
 * Audience: the user, their admins/managers, or both. The manager alerts
 * distinguish USER problems from SYSTEM problems (supply, health) so admins
 * never blame a user for capacity the system failed to provide.
 */

import { loadSnapshot, debouncedSaver } from "../db";
import { rid, nowIso } from "../core/ids";
import { listMembers } from "../auth/team";
import { userCapacity, expectedPaceByHour } from "./capacity";
import { listRollups, sumCounts, workspaceTz } from "./rollup";
import { localDay, localHour, localDow } from "./goals";
import { uncontactedForWorkspace, listsLine } from "./uncontacted";
import type { AlertSeverity, AlertAudience, OutboundAlert, UserDayRollup } from "./types";

const KEY = "outbound_alerts_v1";
const CAP = 800;

let state: Record<string, OutboundAlert[]> = {};
let hydrated = false;
let hydrating: Promise<void> | null = null;
const save = debouncedSaver(KEY, () => state);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<Record<string, OutboundAlert[]>>(KEY);
      if (snap && typeof snap === "object") state = snap;
      hydrated = true;
    })();
  }
  return hydrating;
}

export async function listAlerts(workspaceId: string, opts: { userId?: string; day?: string; limit?: number } = {}): Promise<OutboundAlert[]> {
  await hydrate();
  let rows = state[workspaceId] ?? [];
  if (opts.userId !== undefined) rows = rows.filter((a) => a.userId === opts.userId || a.userId === null);
  if (opts.day) rows = rows.filter((a) => a.day === opts.day);
  return rows.slice(0, opts.limit ?? 200);
}

export async function markAlertRead(workspaceId: string, alertId: string, userId: string): Promise<void> {
  await hydrate();
  const a = (state[workspaceId] ?? []).find((x) => x.id === alertId);
  if (a && !a.readBy.includes(userId)) { a.readBy.push(userId); save(); }
}

async function emit(
  workspaceId: string, day: string,
  a: { userId: string | null; audience: AlertAudience; severity: AlertSeverity; kind: string; title: string; detail: string; recommended?: string },
): Promise<OutboundAlert | null> {
  await hydrate();
  const list = state[workspaceId] ?? (state[workspaceId] = []);
  // Dedupe: one (user, kind) per day.
  if (list.some((x) => x.day === day && x.kind === a.kind && x.userId === a.userId)) return null;
  const alert: OutboundAlert = { id: rid("oba"), workspaceId, day, at: nowIso(), readBy: [], ...a };
  list.unshift(alert);
  if (list.length > CAP) list.length = CAP;
  save();
  return alert;
}

/** Trailing average daily outbound (sends) over a window, working days only. */
function avgDaily(rows: UserDayRollup[], workingDays: number[]): number {
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const c = r.counts;
    const sends = c.bdEmailsSent + c.recruitingEmailsSent + c.liConnectionsSent + c.liMessagesSent
      + c.liVoiceNotes + c.liInMails + c.smsSent + c.voiceTouches;
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + sends);
  }
  const vals = [...byDay.entries()]
    .filter(([day]) => workingDays.includes(new Date(day + "T12:00:00Z").getUTCDay()))
    .map(([, v]) => v);
  if (!vals.length) return 0;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

/** Evaluate every trigger for every member of a workspace. Returns new alerts. */
export async function evaluateTriggers(workspaceId: string): Promise<OutboundAlert[]> {
  const tz = await workspaceTz(workspaceId);
  const today = localDay(tz);
  const members = listMembers(workspaceId);
  const created: OutboundAlert[] = [];
  const push = async (a: Parameters<typeof emit>[2]) => {
    const r = await emit(workspaceId, today, a);
    if (r) created.push(r);
  };
  // Uncontacted-candidate radar: computed at most once per evaluate call, and only
  // when some member actually reaches that trigger (lazy).
  let uncontactedCache: Awaited<ReturnType<typeof uncontactedForWorkspace>> | null = null;
  const uncontactedSummary = async () => (uncontactedCache ??= await uncontactedForWorkspace(workspaceId));

  for (const m of members) {
    let cap;
    try { cap = await userCapacity(workspaceId, m.userId, m.role); } catch { continue; }
    const goals = cap.ctx.goals;
    const hour = localHour(goals.timezone);
    const dow = localDow(goals.timezone);
    const isWorkDay = goals.workingDays.includes(dow);
    const name = m.name || m.email;

    /* ---------- pace (only meaningful during the user's working day) ------ */
    if (isWorkDay && cap.email.state !== "not_enabled" && !cap.supply.constrained) {
      const pace = expectedPaceByHour(goals, hour);
      const expected = Math.round(cap.email.target * pace);
      if (hour >= 12 && hour < 15 && expected > 0 && cap.email.targetPct < goals.triggers.emailUtilNoonPct) {
        await push({
          userId: m.userId, audience: "user", severity: "warning", kind: "email_below_pace_noon",
          title: "Email outreach below pace",
          detail: `${cap.email.used} of ${cap.email.target} target emails sent by midday (${cap.email.targetPct}%). At this pace the day finishes well under target.`,
          recommended: cap.email.recommendedAction,
        });
      }
      if (hour >= 15 && expected > 0 && cap.email.targetPct < goals.triggers.emailUtilAfternoonPct) {
        await push({
          userId: m.userId, audience: "user", severity: "warning", kind: "email_below_pace_afternoon",
          title: "Email target at risk",
          detail: `${cap.email.used} of ${cap.email.target} target emails sent by 3 PM (${cap.email.targetPct}%).`,
          recommended: cap.email.recommendedAction,
        });
      }
    }

    /* ------------------------- LinkedIn utilization ---------------------- */
    if (isWorkDay && hour >= 14 && cap.linkedin.state === "underutilized" && cap.linkedin.targetPct < goals.triggers.linkedinUtilPct) {
      await push({
        userId: m.userId, audience: "user", severity: "warning", kind: "linkedin_below_target",
        title: "LinkedIn outreach below target",
        detail: `${cap.linkedin.used} of ${cap.linkedin.target} LinkedIn actions completed (${cap.linkedin.targetPct}%).`,
        recommended: cap.linkedin.recommendedAction,
      });
    }

    /* ----------------------------- SMS backlog --------------------------- */
    const pendingConvos = cap.response.remaining;
    if (pendingConvos > 0 && (cap.response.reasons.join(" ").includes("Oldest waiting") || pendingConvos >= 5)) {
      await push({
        userId: m.userId, audience: pendingConvos >= 10 ? "both" : "user",
        severity: pendingConvos >= 10 ? "critical" : "warning", kind: "replies_waiting",
        title: `${pendingConvos} conversation${pendingConvos === 1 ? "" : "s"} waiting on a reply`,
        detail: cap.response.reasons.join(" · "),
        recommended: cap.response.recommendedAction,
      });
    }

    /* ------------------------------ content ------------------------------ */
    if (cap.content.state === "underutilized" && goals.channels.liPostsPerWeek.target > 0) {
      await push({
        userId: m.userId, audience: "user", severity: "warning", kind: "linkedin_content_below_target",
        title: "LinkedIn content activity below target",
        detail: `${cap.content.used} post${cap.content.used === 1 ? "" : "s"} in the last 7 days against a goal of ${cap.content.target}.`,
        recommended: cap.content.recommendedAction,
      });
    }

    /* ---------------------------- follow-ups ----------------------------- */
    if (cap.followUp.remaining > 0 && cap.followUp.state === "underutilized") {
      await push({
        userId: m.userId, audience: "user", severity: "warning", kind: "followups_overdue",
        title: "Follow-ups overdue",
        detail: `${cap.followUp.remaining} sequence touches are due and unsent.`,
        recommended: cap.followUp.recommendedAction,
      });
    }

    /* ------------------------- supply constraint ------------------------- */
    if (cap.supply.constrained) {
      await push({
        userId: m.userId, audience: "admin", severity: "critical", kind: "supply_constraint",
        title: `Outreach supply constraint for ${name}`,
        detail: `${name} has unused sending capacity but only ${cap.supply.contactsReady} contacts ready in active campaigns. This is a supply problem, not a user problem.`,
        recommended: "Add contacts to an active campaign or activate another campaign for this user.",
      });
    }
    if (cap.supply.activeCampaigns === 0) {
      await push({
        userId: m.userId, audience: "admin", severity: "critical", kind: "no_active_campaigns",
        title: `${name} has no active campaigns`,
        detail: "Outbound capacity exists but no campaign is assigned or active.",
        recommended: "Assign or activate a campaign for this user.",
      });
    }

    /* ------------------ candidates awaiting first outreach ---------------- */
    // Computed once per workspace below the member loop would race the day-dedupe;
    // the summary is fetched lazily (first member that needs it) and reused.
    if (isWorkDay) {
      try {
        const summary = await uncontactedSummary();
        const mine = summary.byUser[m.userId];
        if (mine && mine.total > 0) {
          await push({
            userId: m.userId, audience: "user", severity: "opportunity", kind: "uncontacted_candidates",
            title: `${mine.total} candidate${mine.total === 1 ? "" : "s"} waiting for first outreach`,
            detail: `Your searches hold ${mine.total} candidate${mine.total === 1 ? "" : "s"} nobody has contacted on any channel yet: ${listsLine(mine.lists)}.`,
            recommended: "Open Candidates, filter to Uncontacted, and start their first touch (or launch the list's OS Text campaign).",
          });
        }
      } catch { /* radar is best-effort; the rest of the triggers still run */ }
    }

    /* --------------------------- system health --------------------------- */
    for (const f of cap.systemFactors.filter((x) => x.severity === "critical" && x.scope !== "global")) {
      await push({
        userId: m.userId, audience: "admin", severity: "critical", kind: `system_${f.scope}`,
        title: `System limitation on ${f.scope} for ${name}`,
        detail: f.reason,
        recommended: "Fix the system issue before judging outreach volume.",
      });
    }

    /* ----------------- baselines: drops, declines, streaks --------------- */
    const wsTz = goals.timezone;
    const d7 = localDay(wsTz, new Date(Date.now() - 7 * 86_400_000));
    const d37 = localDay(wsTz, new Date(Date.now() - 37 * 86_400_000));
    const recent = await listRollups(workspaceId, { userId: m.userId, sinceDay: d7 });
    const baselineRows = await listRollups(workspaceId, { userId: m.userId, sinceDay: d37, untilDay: d7 });
    const recentAvg = avgDaily(recent, goals.workingDays);
    const baseAvg = avgDaily(baselineRows, goals.workingDays);
    if (baseAvg >= 5 && recentAvg < baseAvg * (1 - goals.triggers.activityDropPct / 100)) {
      const dropPct = Math.round((1 - recentAvg / baseAvg) * 100);
      await push({
        userId: m.userId, audience: "both", severity: "warning", kind: "activity_drop",
        title: `${name}'s outbound activity is down ${dropPct}%`,
        detail: `Daily average ${Math.round(recentAvg)} outbound actions this week vs a personal 30-day baseline of ${Math.round(baseAvg)}.`,
        recommended: "Review workload, campaign supply, and channel health with the user.",
      });
    }

    const recentPos = sumCounts(recent).positiveReplies;
    const basePos = sumCounts(baselineRows).positiveReplies / Math.max(1, 30 / 7);
    if (recentPos >= 3 && basePos > 0 && recentPos > basePos * 1.2) {
      await push({
        userId: m.userId, audience: "both", severity: "achievement", kind: "positive_rate_up",
        title: `${name}'s positive responses are up`,
        detail: `${recentPos} positive replies this week vs a ${Math.round(basePos)}/week baseline.`,
      });
    }

    /* -------------------- 100% utilization achievement ------------------- */
    if (cap.email.state !== "not_enabled" && cap.email.targetPct >= 100 && cap.linkedin.targetPct >= 100) {
      await push({
        userId: m.userId, audience: "both", severity: "achievement", kind: "full_utilization",
        title: `${name} hit 100% of recommended utilization`,
        detail: `Email ${cap.email.used}/${cap.email.target} and LinkedIn ${cap.linkedin.used}/${cap.linkedin.target} targets both met.`,
      });
    }

    /* --------------------- persistent underutilization ------------------- */
    const days = goals.triggers.underutilizedDays;
    const floor = goals.triggers.managerUtilFloorPct;
    if (days > 0 && baseAvg + recentAvg > 0) {
      const window = await listRollups(workspaceId, { userId: m.userId, sinceDay: localDay(wsTz, new Date(Date.now() - (days + 2) * 86_400_000)) });
      const workRows = window.filter((r) => goals.workingDays.includes(new Date(r.day + "T12:00:00Z").getUTCDay()) && r.day !== today);
      if (workRows.length >= days) {
        const target = cap.email.target + cap.linkedin.target + cap.sms.target;
        if (target > 0) {
          const unders = workRows.slice(-days).filter((r) => {
            const cc = r.counts;
            const sends = cc.bdEmailsSent + cc.recruitingEmailsSent + cc.liConnectionsSent + cc.liMessagesSent + cc.liVoiceNotes + cc.liInMails + cc.smsSent;
            return (sends / target) * 100 < floor;
          });
          if (unders.length >= days) {
            await push({
              userId: m.userId, audience: "admin", severity: "critical", kind: "persistent_underutilization",
              title: `User underutilization alert: ${name}`,
              detail: `${name} has been under ${floor}% of recommended outbound volume for ${days} consecutive working days.`,
              recommended: "Review active campaign volume, channel assignments, and workload with this user.",
            });
          }
        }
      }
    }
  }

  /* --------- candidates waiting on campaigns NOBODY owns (admin) ---------- */
  // A recruiter can't act on a list that isn't theirs; unassigned supply is an
  // admin problem, exactly like supply_constraint.
  try {
    if (members.length) {
      const summary = uncontactedCache ?? await uncontactedForWorkspace(workspaceId);
      if (summary.unassigned.total > 0) {
        await push({
          userId: null, audience: "admin", severity: "warning", kind: "uncontacted_unassigned",
          title: `${summary.unassigned.total} uncontacted candidate${summary.unassigned.total === 1 ? "" : "s"} on unassigned campaigns`,
          detail: `These candidates are waiting for a first touch but their campaigns have no recruiter assigned: ${listsLine(summary.unassigned.lists)}.`,
          recommended: "Assign a recruiter to each campaign (Send Queue / campaign settings) so this supply lands on someone's daily plan.",
        });
      }
    }
  } catch { /* best-effort */ }

  return created;
}
