/**
 * RecruitersOS · Outbound Performance · daily aggregation
 *
 * The "aggregation table": per-user per-day counters computed from the
 * normalized event stream and PERSISTED (snapshot `outbound_rollups_v1`), so
 * the dashboards read counters, not raw scans, and history survives the raw
 * sources' retention caps (the LinkedIn ledger keeps 20k rows, responses 5k).
 *
 * Refresh strategy: a rebuild covers the trailing REBUILD_DAYS and overwrites
 * those days in place (idempotent); older days are immutable history. Reads
 * self-refresh behind a short TTL, and the scheduler tick keeps it warm.
 */

import { loadSnapshot, debouncedSaver } from "../db";
import { nowIso } from "../core/ids";
import { collectOutboundEvents } from "./events";
import { getGoalsConfig, localDay } from "./goals";
import type { DayCounts, OutboundEvent, UserDayRollup } from "./types";

const KEY = "outbound_rollups_v1";
const REBUILD_DAYS = 35;
const TTL_MS = 60_000;
const KEEP_DAYS = 400;

type WsRollups = Record<string, UserDayRollup>; // key `${userId}|${day}`
let state: Record<string, WsRollups> = {};
let hydrated = false;
let hydrating: Promise<void> | null = null;
const save = debouncedSaver(KEY, () => state);
const lastRefresh = new Map<string, number>();
const refreshing = new Map<string, Promise<void>>();

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<Record<string, WsRollups>>(KEY);
      if (snap && typeof snap === "object") state = snap;
      hydrated = true;
    })();
  }
  return hydrating;
}

export function emptyCounts(): DayCounts {
  return {
    bdEmailsSent: 0, recruitingEmailsSent: 0,
    liConnectionsSent: 0, liConnectionsAccepted: 0, liMessagesSent: 0,
    liVoiceNotes: 0, liInMails: 0, liProfileViews: 0, liPostsPublished: 0,
    smsSent: 0, smsReceived: 0, smsOptOuts: 0, voiceTouches: 0,
    followUpsCompleted: 0, repliesReceived: 0, positiveReplies: 0,
    meetingsBooked: 0, candidateConversations: 0, bdConversations: 0,
  };
}

function bump(c: DayCounts, e: OutboundEvent): void {
  switch (e.eventType) {
    case "EMAIL_SENT": e.motion === "bd" ? c.bdEmailsSent++ : c.recruitingEmailsSent++; break;
    case "LINKEDIN_CONNECTION_SENT": c.liConnectionsSent++; break;
    case "LINKEDIN_CONNECTION_ACCEPTED": c.liConnectionsAccepted++; break;
    case "LINKEDIN_MESSAGE_SENT": c.liMessagesSent++; break;
    case "LINKEDIN_VOICE_NOTE_SENT": c.liVoiceNotes++; break;
    case "LINKEDIN_INMAIL_SENT": c.liInMails++; break;
    case "LINKEDIN_PROFILE_VIEWED": c.liProfileViews++; break;
    case "LINKEDIN_POST_PUBLISHED": c.liPostsPublished++; break;
    case "SMS_SENT": c.smsSent++; break;
    case "SMS_RECEIVED": c.smsReceived++; break;
    case "SMS_OPT_OUT": c.smsOptOuts++; break;
    case "VOICE_TOUCH_SENT": c.voiceTouches++; break;
    case "FOLLOW_UP_COMPLETED": c.followUpsCompleted++; break;
    case "EMAIL_REPLIED": case "LINKEDIN_MESSAGE_REPLIED": c.repliesReceived++; break;
    case "EMAIL_POSITIVE_REPLY": c.positiveReplies++; break;
    case "MEETING_BOOKED": c.meetingsBooked++; break;
    case "CANDIDATE_CONVERSATION_STARTED": c.candidateConversations++; break;
    case "BD_OPPORTUNITY_CREATED": c.bdConversations++; break;
  }
}

/** Events that count as an outbound SEND for the hourly pace strip. */
const SEND_TYPES = new Set([
  "EMAIL_SENT", "LINKEDIN_CONNECTION_SENT", "LINKEDIN_MESSAGE_SENT",
  "LINKEDIN_VOICE_NOTE_SENT", "LINKEDIN_INMAIL_SENT", "SMS_SENT", "VOICE_TOUCH_SENT",
]);

/** Workspace reporting timezone (the GLOBAL goals tier; users may differ for
 *  notifications, but day-bucketing needs one consistent calendar). */
export async function workspaceTz(workspaceId: string): Promise<string> {
  const cfg = await getGoalsConfig(workspaceId);
  return cfg.global.timezone || "America/New_York";
}

/** Rebuild the trailing window for a workspace and persist. */
export async function refreshRollups(workspaceId: string, force = false): Promise<void> {
  await hydrate();
  const at = lastRefresh.get(workspaceId) ?? 0;
  if (!force && Date.now() - at < TTL_MS) return;
  const inFlight = refreshing.get(workspaceId);
  if (inFlight) return inFlight;

  const run = (async () => {
    const tz = await workspaceTz(workspaceId);
    const events = await collectOutboundEvents(workspaceId, { sinceDays: REBUILD_DAYS });
    const ws: WsRollups = state[workspaceId] ?? {};

    // Clear the rebuild window (idempotent overwrite), keep older history.
    const windowDays = new Set<string>();
    for (let i = 0; i < REBUILD_DAYS; i++) {
      windowDays.add(localDay(tz, new Date(Date.now() - i * 86_400_000)));
    }
    for (const k of Object.keys(ws)) {
      const day = k.split("|")[1];
      if (windowDays.has(day)) delete ws[k];
    }

    const today = localDay(tz);
    const yesterday = localDay(tz, new Date(Date.now() - 86_400_000));
    for (const e of events) {
      const day = localDay(tz, new Date(Date.parse(e.at)));
      if (!windowDays.has(day)) continue;
      const uid = e.userId ?? "";
      const k = `${uid}|${day}`;
      let r = ws[k];
      if (!r) {
        r = { workspaceId, userId: uid, day, counts: emptyCounts(), updatedAt: nowIso() };
        ws[k] = r;
      }
      bump(r.counts, e);
      if (SEND_TYPES.has(e.eventType) && (day === today || day === yesterday)) {
        if (!r.hourly) r.hourly = Array.from({ length: 24 }, () => 0);
        let h = 0;
        try {
          h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date(Date.parse(e.at)))) % 24;
        } catch { h = new Date(Date.parse(e.at)).getUTCHours(); }
        r.hourly[h] = (r.hourly[h] ?? 0) + 1;
      }
      r.updatedAt = nowIso();
    }

    // Prune ancient history so the snapshot stays bounded.
    const cutoff = localDay(tz, new Date(Date.now() - KEEP_DAYS * 86_400_000));
    for (const k of Object.keys(ws)) {
      if ((k.split("|")[1] || "") < cutoff) delete ws[k];
    }

    state[workspaceId] = ws;
    lastRefresh.set(workspaceId, Date.now());
    save();
  })().finally(() => refreshing.delete(workspaceId));
  refreshing.set(workspaceId, run);
  return run;
}

export interface RollupQuery {
  userId?: string;         // exact user ("" = unattributed bucket)
  sinceDay?: string;       // inclusive YYYY-MM-DD
  untilDay?: string;       // inclusive
}

export async function listRollups(workspaceId: string, q: RollupQuery = {}): Promise<UserDayRollup[]> {
  await refreshRollups(workspaceId);
  const ws = state[workspaceId] ?? {};
  return Object.values(ws).filter((r) =>
    (q.userId === undefined || r.userId === q.userId) &&
    (!q.sinceDay || r.day >= q.sinceDay) &&
    (!q.untilDay || r.day <= q.untilDay),
  ).sort((a, b) => a.day.localeCompare(b.day));
}

export async function getDay(workspaceId: string, userId: string, day: string): Promise<UserDayRollup> {
  await refreshRollups(workspaceId);
  return state[workspaceId]?.[`${userId}|${day}`]
    ?? { workspaceId, userId, day, counts: emptyCounts(), updatedAt: nowIso() };
}

/** Sum a list of rollups into one DayCounts. */
export function sumCounts(rows: UserDayRollup[]): DayCounts {
  const total = emptyCounts();
  for (const r of rows) {
    for (const k of Object.keys(total) as Array<keyof DayCounts>) total[k] += r.counts[k] ?? 0;
  }
  return total;
}
