/**
 * RecruitersOS · Response · Operator notification ("someone replied — go!")
 *
 * The 20-minute daily model only works if a hot reply PINGS the operator instead of
 * waiting in a tab. When the response router hits a push_notification action (hot lead
 * replied, referral captured, needs human review), this emails the operator immediately.
 *
 * Opt-in: set RECRUITEROS_NOTIFY_EMAIL=<you@yourdomain>. Without it this is a no-op
 * (the router still logs the action). Transport: the owned MTA when opted in, else the
 * first active inbox in the workspace's sender pool. A notification send does NOT count
 * against an inbox's 2/day cold cap (recordSend is deliberately skipped — this is an
 * internal note, not outreach). Never throws; a notification failure must not affect
 * reply processing.
 */

import type { Prospect } from "../core/types";

export function notifyEmail(): string {
  return (process.env.RECRUITEROS_NOTIFY_EMAIL || "").trim();
}

export interface ReplyNotice {
  workspaceId: string;
  detail?: string;          // the rule's human line ("Hot lead replied — correspond manually now")
  channel?: string;
  text?: string;            // the reply body
  fromHandle?: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Email the operator about an inbound reply. Best-effort; returns whether a send happened. */
export async function notifyReply(n: ReplyNotice, prospect: Prospect | null): Promise<boolean> {
  const to = notifyEmail();
  if (!to) return false;

  const who = prospect
    ? `${prospect.fullName}${prospect.title ? ` (${prospect.title})` : ""}${prospect.company ? ` at ${prospect.company}` : ""}`
    : n.fromHandle || "a prospect";
  const subject = `Reply: ${who}`;
  const app = process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co";
  const lines = [
    `<p><b>${esc(n.detail || "A prospect replied")}</b></p>`,
    `<p>From: ${esc(who)}${prospect?.email ? ` &lt;${esc(prospect.email)}&gt;` : ""}${n.channel ? ` via ${esc(n.channel)}` : ""}</p>`,
    n.text ? `<blockquote style="border-left:3px solid #ccc;margin:8px 0;padding:4px 12px;color:#333">${esc(n.text.slice(0, 1200))}</blockquote>` : "",
    `<p><a href="${app}/command#conversations">Open Conversations</a> — their sequences are already paused.</p>`,
  ].filter(Boolean);
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5">${lines.join("")}</div>`;

  // Transport 1: the owned MTA (when opted in).
  try {
    const { mtaPreferred, sendEmail } = await import("../providers/mta");
    if (mtaPreferred()) {
      const r = await sendEmail(n.workspaceId, { to, subject, htmlBody: html });
      if (r.ok) return true;
    }
  } catch { /* fall through to the pool */ }

  // Transport 2: any active inbox in the sender pool (no recordSend — see header).
  try {
    const { listInboxes, sendViaInbox } = await import("../senders");
    const inboxes = await listInboxes(n.workspaceId);
    const inbox = inboxes.find((m) => m.status === "active") || inboxes.find((m) => m.status === "warming");
    if (!inbox) return false;
    const r = await sendViaInbox(inbox, { to, subject, html });
    return r.ok;
  } catch {
    return false;
  }
}
