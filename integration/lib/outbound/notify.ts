/**
 * RecruitersOS · Outbound Performance · user notifications
 *
 * In-app inbox (always), plus email and SMS delivery per user preference.
 * Admins can mark categories REQUIRED (users cannot disable those; enforced
 * here, server-side, not in the UI). Transport reuses what exists: the owned
 * MTA -> sender-pool fallback (same as lib/response/notify) for email, and
 * the Telnyx SMS provider for texts (user phone comes from the goals config,
 * since the auth user model has no phone field).
 *
 * The three scheduled sends (morning summary, midday pace warning, end-of-day
 * report) are BUILT here from the real numbers and dispatched by worker.ts in
 * each user's configured window.
 */

import { loadSnapshot, debouncedSaver } from "../db";
import { rid, nowIso } from "../core/ids";
import { listMembers } from "../auth/team";
import { getGoalsConfig, localDay } from "./goals";
import { userCapacity } from "./capacity";
import { getDay, workspaceTz } from "./rollup";
import { computeScore } from "./score";
import type {
  AlertSeverity, NotifyCategory, NotifyPrefs, OutboundNotification, UserCapacity,
} from "./types";

/* ------------------------------- stores --------------------------------- */

interface NotifyState {
  /** `${ws}|${userId}` -> prefs */
  prefs: Record<string, NotifyPrefs>;
  /** ws -> notifications (newest first, capped) */
  inbox: Record<string, OutboundNotification[]>;
  /** `${ws}|${userId}|${day}|${kind}` sent-guard for scheduled sends */
  sent: Record<string, string>;
}

const KEY = "outbound_notify_v1";
const CAP = 600;
let state: NotifyState = { prefs: {}, inbox: {}, sent: {} };
let hydrated = false;
let hydrating: Promise<void> | null = null;
const save = debouncedSaver(KEY, () => state);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<NotifyState>(KEY);
      if (snap && typeof snap === "object" && snap.inbox) state = { prefs: snap.prefs ?? {}, inbox: snap.inbox ?? {}, sent: snap.sent ?? {} };
      hydrated = true;
    })();
  }
  return hydrating;
}

const DEFAULT_PREFS: NotifyPrefs = { inApp: true, email: true, sms: false, disabled: [] };

export async function getPrefs(workspaceId: string, userId: string): Promise<NotifyPrefs> {
  await hydrate();
  return state.prefs[`${workspaceId}|${userId}`] ?? { ...DEFAULT_PREFS };
}

export async function setPrefs(workspaceId: string, userId: string, p: Partial<NotifyPrefs>): Promise<NotifyPrefs> {
  await hydrate();
  const cur = await getPrefs(workspaceId, userId);
  const next: NotifyPrefs = {
    inApp: p.inApp ?? cur.inApp,
    email: p.email ?? cur.email,
    sms: p.sms ?? cur.sms,
    disabled: Array.isArray(p.disabled) ? (p.disabled as NotifyCategory[]) : cur.disabled,
  };
  state.prefs[`${workspaceId}|${userId}`] = next;
  save();
  return next;
}

export async function listNotifications(workspaceId: string, userId: string, limit = 50): Promise<OutboundNotification[]> {
  await hydrate();
  return (state.inbox[workspaceId] ?? []).filter((n) => n.userId === userId).slice(0, limit);
}

export async function markNotificationRead(workspaceId: string, userId: string, id: string): Promise<void> {
  await hydrate();
  const n = (state.inbox[workspaceId] ?? []).find((x) => x.id === id && x.userId === userId);
  if (n && !n.read) { n.read = true; save(); }
}

/* ------------------------------ delivery -------------------------------- */

async function deliverEmail(workspaceId: string, to: string, subject: string, text: string): Promise<boolean> {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const app = process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co";
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;white-space:pre-line">${esc(text)}\n\n<a href="${app}/recruiter#myoutbound">Open My Outbound</a></div>`;
  try {
    const { mtaPreferred, sendEmail } = await import("../providers/mta");
    if (mtaPreferred()) {
      const r = await sendEmail(workspaceId, { to, subject, htmlBody: html });
      if (r.ok) return true;
    }
  } catch { /* fall through */ }
  try {
    const { listInboxes, sendViaInbox } = await import("../senders");
    const inboxes = await listInboxes(workspaceId);
    const inbox = inboxes.find((m) => m.status === "active") || inboxes.find((m) => m.status === "warming");
    if (!inbox) return false;
    const r = await sendViaInbox(inbox, { to, subject, html });
    return !!r.ok;
  } catch { return false; }
}

async function deliverSms(workspaceId: string, phone: string, text: string): Promise<boolean> {
  try {
    const { getSmsProvider } = await import("../sms/provider");
    const from = process.env.TELNYX_FROM_NUMBER || "";
    if (!from || !phone) return false;
    const r = await getSmsProvider().send({ from, to: phone, text: text.slice(0, 640) });
    return r.ok;
  } catch { return false; }
}

export interface PushInput {
  userId: string;
  category: NotifyCategory;
  severity: AlertSeverity;
  title: string;
  body: string;
}

/** Store in-app + deliver via the user's enabled channels (required categories
 *  are always delivered in-app regardless of prefs). */
export async function pushNotification(workspaceId: string, n: PushInput): Promise<OutboundNotification> {
  await hydrate();
  const cfg = await getGoalsConfig(workspaceId);
  const prefs = await getPrefs(workspaceId, n.userId);
  const required = new Set<NotifyCategory>([...(cfg.global.requiredCategories ?? []), "system"]);
  const muted = prefs.disabled.includes(n.category) && !required.has(n.category);

  const rec: OutboundNotification = {
    id: rid("obn"), workspaceId, userId: n.userId, category: n.category,
    severity: n.severity, title: n.title, body: n.body, at: nowIso(), read: false,
  };

  if (!muted || required.has(n.category)) {
    const list = state.inbox[workspaceId] ?? (state.inbox[workspaceId] = []);
    list.unshift(rec);
    if (list.length > CAP) list.length = CAP;
    save();
  }

  if (!muted) {
    const member = listMembers(workspaceId).find((m) => m.userId === n.userId);
    if (prefs.email && member?.email && !member.email.includes("(unknown)")) {
      rec.deliveredEmail = await deliverEmail(workspaceId, member.email, `RecruitersOS: ${n.title}`, n.body);
    }
    const phone = cfg.userPhones[n.userId];
    if (prefs.sms && phone) {
      rec.deliveredSms = await deliverSms(workspaceId, phone, `${n.title}\n${n.body}`);
    }
    save();
  }
  return rec;
}

/* ------------------------ scheduled send guards -------------------------- */

export async function alreadySent(workspaceId: string, userId: string, day: string, kind: string): Promise<boolean> {
  await hydrate();
  return !!state.sent[`${workspaceId}|${userId}|${day}|${kind}`];
}

export async function markSent(workspaceId: string, userId: string, day: string, kind: string): Promise<void> {
  await hydrate();
  state.sent[`${workspaceId}|${userId}|${day}|${kind}`] = nowIso();
  // Prune old guards (> 7 days).
  const cutoff = localDay("UTC", new Date(Date.now() - 8 * 86_400_000));
  for (const k of Object.keys(state.sent)) {
    const d = k.split("|")[2];
    if (d && d < cutoff) delete state.sent[k];
  }
  save();
}

/* -------------------------- message builders ----------------------------- */

const nice = (n: number) => n.toLocaleString("en-US");

function topPriorities(cap: UserCapacity): string[] {
  const actions: Array<{ gap: number; line: string }> = [];
  for (const ch of [cap.email, cap.linkedin, cap.sms, cap.followUp, cap.content, cap.response]) {
    if (ch.recommendedAction && ch.state !== "not_enabled") {
      actions.push({ gap: ch.key === "response" ? ch.remaining * 3 : Math.max(0, ch.target - ch.used), line: ch.recommendedAction });
    }
  }
  return actions.sort((a, b) => b.gap - a.gap).slice(0, 4).map((a) => a.line);
}

export async function buildMorning(workspaceId: string, userId: string, firstName: string): Promise<{ title: string; body: string } | null> {
  const tz = await workspaceTz(workspaceId);
  const yesterday = localDay(tz, new Date(Date.now() - 86_400_000));
  const cap = await userCapacity(workspaceId, userId);
  const y = await getDay(workspaceId, userId, yesterday);
  const yc = y.counts;
  const ySends = yc.bdEmailsSent + yc.recruitingEmailsSent + yc.liConnectionsSent + yc.liMessagesSent + yc.liVoiceNotes + yc.liInMails + yc.smsSent;
  const priorities = topPriorities(cap);
  if (!priorities.length && ySends === 0) return null;

  const lines = [
    `Good morning ${firstName}.`,
    "",
    `Yesterday: ${nice(ySends)} outbound actions, ${nice(yc.repliesReceived)} replies, ${nice(yc.positiveReplies)} positive, ${nice(yc.meetingsBooked)} meetings.`,
    "",
    "Recommended priorities today:",
    ...priorities.map((p) => `- ${p}`),
  ];
  return { title: "Your outbound plan for today", body: lines.join("\n") };
}

export async function buildMidday(workspaceId: string, userId: string): Promise<{ title: string; body: string } | null> {
  const cap = await userCapacity(workspaceId, userId);
  if (cap.supply.constrained) return null; // not the user's problem; admins are alerted
  const overall = cap.overallPct;
  if (overall >= 55) return null;
  const priorities = topPriorities(cap);
  const lines = [
    "Outbound activity is currently below pace.",
    "",
    `You have used ${overall}% of today's available outreach capacity.`,
    `Email ${cap.email.used}/${cap.email.target} · LinkedIn ${cap.linkedin.used}/${cap.linkedin.target}` +
      (cap.sms.state !== "not_enabled" ? ` · SMS ${cap.sms.used}/${cap.sms.target}` : ""),
    "",
    "Recommended before end of day:",
    ...priorities.map((p) => `- ${p}`),
  ];
  return { title: "Midday utilization warning", body: lines.join("\n") };
}

export async function buildEod(workspaceId: string, userId: string): Promise<{ title: string; body: string } | null> {
  const tz = await workspaceTz(workspaceId);
  const today = localDay(tz);
  const cap = await userCapacity(workspaceId, userId);
  const t = await getDay(workspaceId, userId, today);
  const c = t.counts;
  const score = computeScore(cap, { positiveReplies: c.positiveReplies, meetingsBooked: c.meetingsBooked });
  const weakest = [...score.components].filter((x) => x.weight > 0).sort((a, b) => a.score - b.score)[0];
  const lines = [
    "Today's RecruitersOS Outbound Report",
    "",
    `Overall utilization: ${cap.overallPct}% · Outbound score: ${score.total}/100`,
    `Email ${cap.email.targetPct}% · LinkedIn ${cap.linkedin.targetPct}%` +
      (cap.sms.state !== "not_enabled" ? ` · SMS ${cap.sms.targetPct}%` : ""),
    "",
    `Positive responses: ${nice(c.positiveReplies)}`,
    `Candidate conversations: ${nice(c.candidateConversations)}`,
    `BD conversations: ${nice(c.bdConversations)}`,
    `Meetings generated: ${nice(c.meetingsBooked)}`,
    "",
    weakest ? `Tomorrow's primary opportunity: ${weakest.label} (${weakest.score}/100).` : "",
  ].filter((l) => l !== undefined);
  return { title: "End-of-day outbound report", body: lines.join("\n") };
}
