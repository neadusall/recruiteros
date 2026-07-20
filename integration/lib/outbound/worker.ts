/**
 * RecruitersOS · Outbound Performance · the scheduler tick
 *
 * Runs from the automation clock (lib/automation/scheduler.ts). Each cycle:
 *   1. refresh rollups for every workspace with members,
 *   2. evaluate the trigger engine (alerts, deduped per day),
 *   3. deliver the scheduled notifications (morning / midday / end-of-day)
 *      inside each user's configured hour, working days only, once per day.
 *
 * Trigger-engine alerts aimed at users are also pushed as notifications here
 * so a fired condition reaches the user through their channels, not just the
 * admin alert feed.
 */

import { devAuthStore } from "../auth";
import { listMembers } from "../auth/team";
import { resolveGoals, localDay, localHour, localDow } from "./goals";
import { refreshRollups } from "./rollup";
import { evaluateTriggers } from "./triggers";
import {
  alreadySent, markSent, pushNotification, buildMorning, buildMidday, buildEod,
} from "./notify";
import type { NotifyCategory } from "./types";

function workspaceIds(): string[] {
  try {
    return [...devAuthStore().workspaces.keys()];
  } catch { return []; }
}

const KIND_TO_CATEGORY: Record<string, NotifyCategory> = {
  email_below_pace_noon: "underutilization",
  email_below_pace_afternoon: "underutilization",
  linkedin_below_target: "underutilization",
  replies_waiting: "follow_up",
  linkedin_content_below_target: "posting",
  followups_overdue: "follow_up",
  activity_drop: "underutilization",
  positive_rate_up: "achievement",
  full_utilization: "achievement",
  uncontacted_candidates: "campaign",
};

export async function runOutboundTick(now: Date = new Date()): Promise<void> {
  for (const ws of workspaceIds()) {
    const members = listMembers(ws);
    if (!members.length) continue;

    try { await refreshRollups(ws, true); } catch { /* next tick retries */ }

    // 2. Trigger engine; forward user-audience alerts into notifications.
    try {
      const created = await evaluateTriggers(ws);
      for (const a of created) {
        if (!a.userId || a.audience === "admin") continue;
        const category = KIND_TO_CATEGORY[a.kind] ?? (a.severity === "achievement" ? "achievement" : "underutilization");
        try {
          await pushNotification(ws, {
            userId: a.userId, category, severity: a.severity,
            title: a.title,
            body: [a.detail, a.recommended ? `Recommended: ${a.recommended}` : ""].filter(Boolean).join("\n"),
          });
        } catch { /* one user's delivery */ }
      }
    } catch { /* one workspace's triggers */ }

    // 3. Scheduled sends per user, in their own timezone/window.
    for (const m of members) {
      try {
        const goals = await resolveGoals(ws, m.userId, m.role);
        const day = localDay(goals.timezone, now);
        const hour = localHour(goals.timezone, now);
        const dow = localDow(goals.timezone, now);
        if (!goals.workingDays.includes(dow)) continue;
        const firstName = (m.firstName || m.name || "there").split(" ")[0];

        if (hour >= goals.morningHour && hour < goals.morningHour + 2 && !(await alreadySent(ws, m.userId, day, "morning"))) {
          const msg = await buildMorning(ws, m.userId, firstName);
          await markSent(ws, m.userId, day, "morning");
          if (msg) await pushNotification(ws, { userId: m.userId, category: "daily_summary", severity: "info", ...msg });
        }
        if (hour >= goals.middayHour && hour < goals.middayHour + 2 && !(await alreadySent(ws, m.userId, day, "midday"))) {
          const msg = await buildMidday(ws, m.userId);
          await markSent(ws, m.userId, day, "midday");
          if (msg) await pushNotification(ws, { userId: m.userId, category: "underutilization", severity: "warning", ...msg });
        }
        if (hour >= goals.eodHour && hour < goals.eodHour + 3 && !(await alreadySent(ws, m.userId, day, "eod"))) {
          const msg = await buildEod(ws, m.userId);
          await markSent(ws, m.userId, day, "eod");
          if (msg) await pushNotification(ws, { userId: m.userId, category: "daily_summary", severity: "info", ...msg });
        }
      } catch { /* one user's schedule */ }
    }
  }
}
