/**
 * RecruitersOS · Outbound Performance · the Daily Checklist worksheet
 *
 * The 10-15 minute morning routine: a fixed, ordered set of steps, each with
 * Today's Target / Current Activity / Remaining / Action Required, computed
 * live from the capacity engine so the user never has to analyze a report.
 * Steps auto-complete when the numbers are met; users can also tick a step
 * manually (persisted per day, snapshot `outbound_checklist_v1`).
 */

import { loadSnapshot, debouncedSaver } from "../db";
import { nowIso } from "../core/ids";
import { userCapacity } from "./capacity";
import { workspaceTz } from "./rollup";
import { localDay } from "./goals";
import { listAlerts } from "./triggers";
import { userAssessment } from "./insights";
import type { ChecklistStep, DailyChecklist } from "./types";

interface ChecklistState {
  /** `${ws}|${userId}|${day}` -> manually ticked step ids */
  ticks: Record<string, string[]>;
}
const KEY = "outbound_checklist_v1";
let state: ChecklistState = { ticks: {} };
let hydrated = false;
let hydrating: Promise<void> | null = null;
const save = debouncedSaver(KEY, () => state);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<ChecklistState>(KEY);
      if (snap && snap.ticks) state = snap;
      hydrated = true;
    })();
  }
  return hydrating;
}

export async function setStepTick(workspaceId: string, userId: string, day: string, stepId: string, done: boolean): Promise<void> {
  await hydrate();
  const k = `${workspaceId}|${userId}|${day}`;
  const list = new Set(state.ticks[k] ?? []);
  if (done) list.add(stepId); else list.delete(stepId);
  state.ticks[k] = [...list];
  // Prune old days.
  const cutoff = localDay("UTC", new Date(Date.now() - 8 * 86_400_000));
  for (const key of Object.keys(state.ticks)) {
    const d = key.split("|")[2];
    if (d && d < cutoff) delete state.ticks[key];
  }
  save();
}

export async function buildChecklist(workspaceId: string, userId: string, authRole = "member"): Promise<DailyChecklist> {
  await hydrate();
  const tz = await workspaceTz(workspaceId);
  const day = localDay(tz);
  const cap = await userCapacity(workspaceId, userId, authRole);
  const ticks = new Set(state.ticks[`${workspaceId}|${userId}|${day}`] ?? []);
  const alerts = await listAlerts(workspaceId, { userId, day });
  const unreadAlerts = alerts.filter((a) => !a.readBy.includes(userId));
  let topActions: string[] = [];
  try { topActions = (await userAssessment(workspaceId, userId, { authRole })).actions; } catch { /* facts still render */ }

  const steps: ChecklistStep[] = [];
  let order = 0;
  const add = (s: Omit<ChecklistStep, "order" | "done">) => {
    steps.push({ ...s, order: ++order, done: s.met || ticks.has(s.id) });
  };

  /* 1 · Review alerts */
  add({
    id: "alerts",
    title: "Review system alerts and notifications",
    target: "0 unread",
    current: `${unreadAlerts.length} unread`,
    remaining: `${unreadAlerts.length}`,
    action: unreadAlerts.length
      ? `Read ${unreadAlerts.length} alert${unreadAlerts.length === 1 ? "" : "s"} below and act on any critical items.`
      : "Nothing waiting. Move on.",
    met: unreadAlerts.length === 0,
    minutes: 2,
    state: unreadAlerts.some((a) => a.severity === "critical") ? "attention" : "ok",
  });

  /* 2 · Replies first (never let conversations wait) */
  const pending = cap.response.remaining;
  add({
    id: "replies",
    title: "Answer waiting conversations (SMS + LinkedIn)",
    target: "0 waiting",
    current: `${pending} waiting`,
    remaining: `${pending}`,
    action: pending ? `Respond to ${pending} conversation${pending === 1 ? "" : "s"} now. Replies beat new outreach.` : "Inbox clear.",
    met: pending === 0,
    minutes: 3,
    link: "#response",
    state: pending === 0 ? "ok" : pending > 5 ? "underutilized" : "attention",
  });

  /* 3 · Follow-ups due */
  add({
    id: "followups",
    title: "Complete due follow-ups",
    target: `${cap.followUp.target} due today`,
    current: `${cap.followUp.used} completed`,
    remaining: `${cap.followUp.remaining}`,
    action: cap.followUp.remaining
      ? `Send the next sequence touch for ${cap.followUp.remaining} prospect${cap.followUp.remaining === 1 ? "" : "s"}.`
      : "All sequence touches are current.",
    met: cap.followUp.remaining === 0,
    minutes: 3,
    link: "#campaigns",
    state: cap.followUp.state === "strong" ? "ok" : cap.followUp.state,
  });

  /* 4 · Email to target (skipped entirely when the channel is not enabled) */
  if (cap.email.state !== "not_enabled") add({
    id: "email",
    title: "Hit today's email target",
    target: `${cap.email.target} emails`,
    current: `${cap.email.used} sent (${cap.email.targetPct}%)`,
    remaining: `${Math.max(0, cap.email.target - cap.email.used)}`,
    action: cap.email.state === "supply_constrained"
      ? "Capacity exceeds ready contacts. Flag your admin to load more campaign supply."
      : cap.email.recommendedAction || "Email target met.",
    met: cap.email.used >= cap.email.target,
    minutes: 2,
    link: "#campaigns",
    state: cap.email.state === "strong" ? "ok" : cap.email.state,
  });

  /* 5 · LinkedIn to target (skipped when no account/goal makes it actionable) */
  if (cap.linkedin.state !== "not_enabled") add({
    id: "linkedin",
    title: "Hit today's LinkedIn target",
    target: `${cap.linkedin.target} actions`,
    current: `${cap.linkedin.used} done (${cap.linkedin.targetPct}%)`,
    remaining: `${Math.max(0, cap.linkedin.target - cap.linkedin.used)}`,
    action: cap.linkedin.state === "system_limited"
      ? "LinkedIn account capacity is limited right now (health/limits). Check the LinkedIn tool."
      : cap.linkedin.recommendedAction || "LinkedIn target met.",
    met: cap.linkedin.used >= cap.linkedin.target,
    minutes: 2,
    link: "#linkedin",
    state: cap.linkedin.state === "strong" ? "ok" : cap.linkedin.state,
  });

  /* 6 · SMS (when enabled) */
  if (cap.sms.state !== "not_enabled") {
    add({
      id: "sms",
      title: "Work today's SMS outreach",
      target: `${cap.sms.target} messages`,
      current: `${cap.sms.used} sent (${cap.sms.targetPct}%)`,
      remaining: `${Math.max(0, cap.sms.target - cap.sms.used)}`,
      action: cap.sms.recommendedAction || "SMS target met.",
      met: cap.sms.used >= cap.sms.target,
      minutes: 2,
      link: "#ostext",
      state: cap.sms.state === "strong" ? "ok" : cap.sms.state,
    });
  }

  /* 7 · Campaign supply check */
  add({
    id: "supply",
    title: "Confirm campaigns have enough contacts",
    target: "Supply covers remaining capacity",
    current: cap.supply.detail,
    remaining: cap.supply.constrained ? "Supply short" : "Covered",
    action: cap.supply.constrained
      ? "Ready contacts are below your remaining capacity. Add contacts to an active campaign or tell your admin."
      : cap.supply.activeCampaigns === 0
        ? "No active campaigns. Activate one or ask your admin for an assignment."
        : "Supply is sufficient today.",
    met: !cap.supply.constrained && cap.supply.activeCampaigns > 0,
    minutes: 1,
    link: "#campaigns",
    state: cap.supply.constrained || cap.supply.activeCampaigns === 0 ? "supply_constrained" : "ok",
  });

  /* 8 · LinkedIn content (weekly goal) */
  if (cap.content.state !== "not_enabled") {
    add({
      id: "content",
      title: "Stay on LinkedIn posting goal",
      target: `${cap.content.target} posts/week`,
      current: `${cap.content.used} in last 7 days`,
      remaining: `${Math.max(0, cap.content.target - cap.content.used)}`,
      action: cap.content.recommendedAction || "Posting goal met this week.",
      met: cap.content.used >= cap.content.target,
      minutes: 2,
      link: "#linkedinposter",
      state: cap.content.state === "strong" ? "ok" : cap.content.state,
    });
  }

  /* 9 · Highest-priority actions from the AI plan */
  add({
    id: "priorities",
    title: "Complete the highest-priority recommended actions",
    target: `${topActions.length || 0} recommended`,
    current: "Review the list",
    remaining: `${topActions.length}`,
    action: topActions.length ? topActions.join(" ") : "No additional recommendations right now.",
    met: topActions.length === 0,
    minutes: 1,
    state: "ok",
  });

  const completed = steps.filter((s) => s.done).length;
  return {
    day,
    userId,
    steps,
    completedSteps: completed,
    totalSteps: steps.length,
    estimatedMinutes: steps.reduce((s, x) => s + x.minutes, 0),
  };
}
