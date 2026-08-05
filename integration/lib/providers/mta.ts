/**
 * RecruitersOS · MTA send provider
 * The owned-infrastructure email sender that replaces Instantly. Picks a warmed
 * mailbox (caps/rotation), checks suppression, sends through that mailbox's
 * Postal server, and records the send for the deliverability engine.
 *
 * Routed from lib/channels when SENDING_EMAIL_PROVIDER=mta (or an active Postal
 * server exists). Falls back cleanly when nothing is ready.
 *
 * COLD-SEND CONTRACT: callers sending marketing/cold mail set `coldOutreach`
 * so BOTH suppression lists (bounce/complaint AND the workspace DNC/STOP list)
 * gate the send, and Gmail/Yahoo-required List-Unsubscribe headers are stamped
 * automatically. Transactional callers (booking confirmations, password mail)
 * leave it unset: DNC does not apply to solicited replies to the person's own
 * action, but hard bounces still block.
 */

import { pickMailbox, recordSend, serverHasCapacity, recordServerSend } from "../sending/caps";
import { getServer, getDomain, recordEvent, isSuppressed, saveServer } from "../sending/store";
import { sendMessage, postalConfigured } from "../sending/postal";
import { mtaEnabled } from "../sending/config";

export interface MtaSendInput {
  to: string;
  subject: string;
  htmlBody?: string;
  plainBody?: string;
  domainId?: string;          // optional: pin to a domain
  fromName?: string;          // display name
  replyTo?: string;
  /** Extra RFC headers (threading, List-Unsubscribe). Merged over the defaults. */
  headers?: Record<string, string>;
  /** Cold/marketing mail: enforces the workspace DNC list + unsubscribe headers. */
  coldOutreach?: boolean;
}

export interface MtaSendResult {
  ok: boolean;
  provider: "mta";
  messageId?: string;
  mailbox?: string;
  error?: string;
  skipped?: "suppressed" | "no_capacity" | "not_ready";
}

/** True when the owned MTA should handle email (portal toggle, else env opt-in). */
export function mtaPreferred(): boolean {
  return mtaEnabled();
}

/** Open tracking on the MTA path (pixel). Default ON; disable for the cleanest
 *  cold posture with SENDING_TRACK_OPENS=0. */
function trackOpens(): boolean {
  return !["0", "false", "no", "off"].includes((process.env.SENDING_TRACK_OPENS || "").toLowerCase());
}
/** Click tracking rewrites every URL through the tracking domain, a known cold
 *  spam signal. Default OFF for cold sends; opt in with SENDING_TRACK_CLICKS=1. */
function trackClicks(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.SENDING_TRACK_CLICKS || "").toLowerCase());
}

/**
 * Send one email through the owned infrastructure. Honors suppression, capacity,
 * and Postal readiness — returns a structured skip rather than throwing so the
 * caller can fall back or defer.
 */
export async function sendEmail(workspaceId: string, input: MtaSendInput): Promise<MtaSendResult> {
  const to = input.to.toLowerCase().trim();
  if (!to) return { ok: false, provider: "mta", error: "no_recipient" };
  if (await isSuppressed(to)) return { ok: false, provider: "mta", skipped: "suppressed" };
  if (input.coldOutreach) {
    // Workspace DNC/STOP/unsubscribe list. The direct callers (BD Bulk, the
    // nurture drip) used to bypass this entirely, so a STOP'd address could
    // still get bulk mail. Fail-closed for cold; errors read as suppressed.
    try {
      const { isSuppressed: isDnc } = await import("../response/suppression");
      if (await isDnc(workspaceId, to)) return { ok: false, provider: "mta", skipped: "suppressed" };
    } catch {
      return { ok: false, provider: "mta", skipped: "suppressed" };
    }
  }

  const pick = await pickMailbox(workspaceId, { domainId: input.domainId });
  if (!pick) return { ok: false, provider: "mta", skipped: "no_capacity" };
  const { mailbox, domain } = pick;

  const server = domain.serverId ? await getServer(workspaceId, domain.serverId) : undefined;
  if (!server || !postalConfigured(server)) return { ok: false, provider: "mta", skipped: "not_ready" };
  // IP/pool warm-up ceiling: protect the shared IP even if a mailbox still has cap.
  if (!serverHasCapacity(server)) return { ok: false, provider: "mta", skipped: "no_capacity" };

  // Gmail/Yahoo bulk-sender rules: every cold send carries one-click unsubscribe.
  let headers = input.headers;
  if (input.coldOutreach) {
    try {
      const { unsubscribeHeaders } = await import("../sending/unsubscribe");
      headers = { ...unsubscribeHeaders(workspaceId, to, mailbox.address), ...(input.headers || {}) };
    } catch { /* headers stay as provided */ }
  }

  const from = input.fromName ? `${input.fromName} <${mailbox.address}>` : mailbox.address;
  try {
    const { messageId } = await sendMessage(server, {
      from,
      to,
      subject: input.subject,
      htmlBody: input.htmlBody,
      plainBody: input.plainBody || stripHtml(input.htmlBody || ""),
      replyTo: input.replyTo || mailbox.address,
      headers,
      trackOpens: trackOpens(),
      trackClicks: trackClicks(),
    });
    await recordSend(mailbox);
    await recordServerSend(workspaceId, domain.serverId);
    if (domain.metrics) domain.metrics.sent += 1;
    await recordEvent({ type: "sent", domainId: domain.id, mailboxId: mailbox.id, to, detail: messageId });
    if (!server.postalReady) { server.postalReady = true; await saveServer(server); }
    return { ok: true, provider: "mta", messageId, mailbox: mailbox.address };
  } catch (e: any) {
    return { ok: false, provider: "mta", error: e?.message || "send_failed" };
  }
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
