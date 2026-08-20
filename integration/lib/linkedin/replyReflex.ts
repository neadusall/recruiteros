/**
 * RecruitersOS · Role Hunter · what happens the moment a poster writes back
 *
 * A reply to one of our comments is the warmest signal the desk produces: a
 * hiring decision-maker, on their own post, answering a stranger in public.
 * Before this module the only thing that happened was a status change on a
 * card nobody was looking at, which is the same as nothing happening (owner
 * ask 2026-08-20: "send me if the person replied ... and connect with them on
 * LinkedIn automatically").
 *
 * Two reflexes, each independent, each once per thread, neither able to throw
 * into the scan that called it:
 *
 *  1. TELL THE RECRUITER. Email to the seat's owner (and the workspace owner),
 *     carrying their exact words, so the answer can be written from a phone.
 *     A text as well where a cell is configured, because an email is not an
 *     interruption and a live conversation is worth one.
 *  2. ASK TO CONNECT. A note-less invitation from THE SAME SEAT that commented,
 *     which is the only seat with any standing to send it. The engine keeps its
 *     policies, pressure caps and health gates; this only decides that the
 *     moment has come.
 *
 * The answer itself is never machine-written. That rule predates this file
 * (owner, 2026-08-19) and this file does not touch it: the tracker still shows
 * their words over an empty box.
 */

import { listMembers } from "../auth/team";
import { workspaceOwner } from "../auth";
import { listLines, numberForUser } from "../phone/store";
import { requestLinkedInAction } from "./os/engine";
import type { LiAccountState } from "./os/types";

/** The ledger tag every reply-triggered invitation carries. */
export const REPLY_CONNECT_WORKFLOW = "role_hunter_reply_connect";

/** The shape this module needs from a tracked comment. Kept structural so
 *  commentWatch owns the item type and this file never imports it back. */
export interface RepliedThread {
  id: string;
  accountId?: string;
  authorName: string;
  authorProviderId?: string;
  authorPublicUrl?: string;
  networkDistance?: string;
  title?: string;
  company?: string;
  postUrl?: string;
  commentDraft?: string;
  responseText?: string;
  prospectId?: string;
  replyAlertAt?: string;
  replyConnectStatus?: "queued" | "skipped";
  replyConnectReason?: string;
}

/* ------------------------------------------------------------------ */
/* Who to tell                                                          */
/* ------------------------------------------------------------------ */

interface Seat {
  userId?: string;
  name?: string;
  email?: string;
}

async function seatOwner(workspaceId: string, accounts: LiAccountState[], accountId?: string): Promise<Seat> {
  const account = accounts.find((a) => a.accountId === accountId);
  let userId = account?.ownerUserId;
  // The desk's oldest engine accounts were registered before seats carried an
  // owner (their accountId IS the provider id, and the adoption bridge counts
  // them as bound, so they never get stamped). Those are the two seats posting
  // the most, so falling back to the seat store is the difference between a
  // recruiter being told and only the owner being told.
  if (!userId && account) {
    try {
      const { seatsForWorkspace } = await import("./seats");
      const seats = await seatsForWorkspace(workspaceId);
      const provider = account.providerAccountId || account.accountId;
      userId = seats.find((s) => s.accountId === provider)?.userId;
    } catch { /* the workspace owner is still copied on every alert */ }
  }
  if (!userId) return { name: account?.displayName };
  const member = listMembers(workspaceId).find((m) => m.userId === userId);
  return { userId, name: member?.name ?? account?.displayName, email: member?.email };
}

/** email -> cell, from `ROLE_HUNTER_ALERT_CELLS=a@b.com:+1555...,c@d.com:+1555...`.
 *  Absent env = email only, which is the safe default: a missing map must never
 *  silently redirect one recruiter's alerts to another recruiter's phone. */
function cellFor(email?: string): string | undefined {
  const map = (process.env.ROLE_HUNTER_ALERT_CELLS || "").trim();
  if (!email || !map) return undefined;
  const want = email.trim().toLowerCase();
  for (const pair of map.split(/[,;]/)) {
    const at = pair.lastIndexOf(":");
    if (at < 0) continue;
    const who = pair.slice(0, at).trim().toLowerCase();
    const num = pair.slice(at + 1).trim();
    if (who === want && num) return num;
  }
  return undefined;
}

/** A desk lead who wants a copy of every reply, whoever's seat drew it. */
function alwaysCell(): string | undefined {
  const n = (process.env.ROLE_HUNTER_ALERT_ALWAYS_CELL || "").trim();
  return n && n.toLowerCase() !== "off" ? n : undefined;
}

async function textOne(workspaceId: string, to: string, from: string | null, text: string): Promise<void> {
  if (!from) return; // no line to send from: the email already went
  const { withWorkspaceCreds } = await import("../connected");
  const { telnyx } = await import("../providers");
  await withWorkspaceCreds(workspaceId, () => telnyx.sendSms(to, text, from));
}

/** Their line first (a recruiter recognizes their own number), then the desk's.
 *  The last fallback matters: without a from-line the text silently does not
 *  send, and a silent alert is the failure this whole module exists to end. */
function fromLine(workspaceId: string, userId?: string): string | null {
  try {
    if (userId) {
      const own = numberForUser(workspaceId, userId);
      if (own) return own;
    }
  } catch { /* fall through to the desk line */ }
  const env = (process.env.ROLE_HUNTER_ALERT_SMS_FROM || process.env.RECRUITEROS_BOOKING_SMS_FROM || "").trim();
  if (env) return env;
  try {
    return listLines(workspaceId).find((l) => !!l.e164)?.e164 || null;
  } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* Reflex 1: tell the recruiter                                         */
/* ------------------------------------------------------------------ */

async function alert(workspaceId: string, item: RepliedThread, seat: Seat): Promise<void> {
  const who = [item.authorName, [item.title, item.company].filter(Boolean).join(" at ")]
    .filter(Boolean).join(", ");
  // The tenant's own portal, never the house one: a Lume recruiter following
  // this link must land on Lume's host (see the workspace brand resolver).
  let app = process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co";
  try {
    const { notifyBrand } = await import("../outbound/brand");
    const brand = await notifyBrand(workspaceId);
    if (brand?.appUrl) app = brand.appUrl;
  } catch { /* house url still reaches a working login */ }

  const to: string[] = [];
  if (seat.email && seat.email !== "(unknown)") to.push(seat.email);
  try {
    const owner = await workspaceOwner(workspaceId);
    if (owner?.email && !to.includes(owner.email)) to.push(owner.email);
  } catch { /* the seat owner alone is still a real alert */ }

  const body = [
    `${who} replied to ${seat.name ? seat.name + "'s" : "your"} comment.`,
    "",
    "They wrote:",
    `"${(item.responseText || "").slice(0, 900)}"`,
    "",
    "You commented:",
    `"${(item.commentDraft || "").slice(0, 400)}"`,
    "",
    item.postUrl ? `The post: ${item.postUrl}` : "",
    `Answer in the thread: ${app}/command#linkedin`,
    "",
    "Your answer posts in your own words, under their reply. Nothing is drafted for you.",
  ].filter(Boolean).join("\n");

  // sendWorkspaceEmail, never the house Resend sender: a white-label desk's
  // recruiters must be mailed from THEIR domain (permanent owner mandate
  // 2026-07-20). It fails closed on a tenant with no mailbox creds, which is
  // the correct failure: the text below still goes, and the tracker still has
  // the reply.
  const { sendWorkspaceEmail } = await import("../auth");
  const subject = `${item.authorName} replied to your comment`;
  for (const address of to) {
    try { await sendWorkspaceEmail(address, subject, body, workspaceId); } catch { /* the text still carries it */ }
  }

  // The text: the interruption. No links and no product names, exactly like
  // the OS Text reply alerts, so it reads as a note from the desk.
  const first = (seat.name || "").split(/\s+/)[0];
  const sms = [
    first ? `${first},` : "",
    `${item.authorName} replied to your comment${item.company ? ` (${item.company})` : ""}:`,
    `"${(item.responseText || "").slice(0, 220)}"`,
    "Answer in the thread while it is live.",
  ].filter(Boolean).join(" ");
  const cells = [cellFor(seat.email), alwaysCell()].filter((c): c is string => !!c);
  const from = fromLine(workspaceId, seat.userId);
  for (const cell of Array.from(new Set(cells))) {
    try { await textOne(workspaceId, cell, from, sms); } catch { /* email already carried it */ }
  }
}

/* ------------------------------------------------------------------ */
/* Reflex 2: ask to connect                                             */
/* ------------------------------------------------------------------ */

const PROFILE_URL = /linkedin\.com\/in\//i;

async function connect(workspaceId: string, item: RepliedThread): Promise<void> {
  if ((process.env.ROLE_HUNTER_REPLY_CONNECT ?? "1") === "0") {
    item.replyConnectStatus = "skipped"; item.replyConnectReason = "Turned off for this desk.";
    return;
  }
  if (item.networkDistance === "FIRST_DEGREE" || item.networkDistance === "DISTANCE_1") {
    item.replyConnectStatus = "skipped"; item.replyConnectReason = "Already connected.";
    return;
  }
  if (!item.accountId) {
    item.replyConnectStatus = "skipped"; item.replyConnectReason = "No seat on the thread.";
    return;
  }
  // authorPublicUrl falls back to the POST url upstream, and an invitation
  // aimed at a post url is an invitation aimed at nobody. Profile or nothing.
  const url = item.authorPublicUrl && PROFILE_URL.test(item.authorPublicUrl) ? item.authorPublicUrl : undefined;
  if (!url) {
    item.replyConnectStatus = "skipped"; item.replyConnectReason = "No profile link on this lead.";
    return;
  }

  const res = await requestLinkedInAction({
    workspaceId,
    accountId: item.accountId,
    person: {
      linkedinUrl: url,
      providerProfileId: item.authorProviderId,
      prospectId: item.prospectId,
      fullName: item.authorName,
      company: item.company,
      title: item.title,
    },
    actionType: "connect", // note-less: the comment thread IS the introduction
    payload: { linkedinUrl: url },
    businessUnit: "bd",
    sourceType: "ai_workflow", // keeps pressure, pause and conflict guards on
    priority: "high", // they are in the thread right now
    workflowId: REPLY_CONNECT_WORKFLOW,
    idempotencyKey: `rhrc|${workspaceId}|${item.id}`,
  });

  if (res.accepted || res.record.status === "capacity_pending") {
    item.replyConnectStatus = "queued";
    item.replyConnectReason = res.record.status === "capacity_pending"
      ? "Queued for the next open slot on your account."
      : undefined;
  } else {
    item.replyConnectStatus = "skipped";
    item.replyConnectReason = res.reason || res.record.status;
  }
}

/* ------------------------------------------------------------------ */

/**
 * Called once, by the thread re-read, at the moment a reply is first seen.
 * Mutates the item (the caller saves) and never throws: a failed alert or a
 * refused invitation must not cost us the reply itself.
 */
export async function posterReplyReflex(
  workspaceId: string, item: RepliedThread, accounts: LiAccountState[],
): Promise<void> {
  const seat = await seatOwner(workspaceId, accounts, item.accountId);
  if (!item.replyAlertAt) {
    item.replyAlertAt = new Date().toISOString();
    try { await alert(workspaceId, item, seat); } catch (e) {
      console.log(`[comment-radar] reply alert failed for ${item.authorName} (${e instanceof Error ? e.message : e})`);
    }
  }
  if (!item.replyConnectStatus) {
    try { await connect(workspaceId, item); } catch (e) {
      item.replyConnectStatus = "skipped";
      item.replyConnectReason = e instanceof Error ? e.message : String(e);
    }
  }
}
