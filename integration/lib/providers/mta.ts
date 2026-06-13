/**
 * RecruitersOS · MTA send provider
 * The owned-infrastructure email sender that replaces Instantly. Picks a warmed
 * mailbox (caps/rotation), checks suppression, sends through that mailbox's
 * Postal server, and records the send for the deliverability engine.
 *
 * Routed from lib/channels when SENDING_EMAIL_PROVIDER=mta (or an active Postal
 * server exists). Falls back cleanly when nothing is ready.
 */

import { pickMailbox, recordSend, serverHasCapacity, recordServerSend } from "../sending/caps";
import { getServer, getDomain, recordEvent, isSuppressed, saveServer } from "../sending/store";
import { sendMessage, postalConfigured } from "../sending/postal";

export interface MtaSendInput {
  to: string;
  subject: string;
  htmlBody?: string;
  plainBody?: string;
  domainId?: string;          // optional: pin to a domain
  fromName?: string;          // display name
  replyTo?: string;
}

export interface MtaSendResult {
  ok: boolean;
  provider: "mta";
  messageId?: string;
  mailbox?: string;
  error?: string;
  skipped?: "suppressed" | "no_capacity" | "not_ready";
}

/** True when the owned MTA should handle email (env opt-in). */
export function mtaPreferred(): boolean {
  return (process.env.SENDING_EMAIL_PROVIDER || "").toLowerCase() === "mta";
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

  const pick = await pickMailbox(workspaceId, { domainId: input.domainId });
  if (!pick) return { ok: false, provider: "mta", skipped: "no_capacity" };
  const { mailbox, domain } = pick;

  const server = domain.serverId ? await getServer(workspaceId, domain.serverId) : undefined;
  if (!server || !postalConfigured(server)) return { ok: false, provider: "mta", skipped: "not_ready" };
  // IP/pool warm-up ceiling: protect the shared IP even if a mailbox still has cap.
  if (!serverHasCapacity(server)) return { ok: false, provider: "mta", skipped: "no_capacity" };

  const from = input.fromName ? `${input.fromName} <${mailbox.address}>` : mailbox.address;
  try {
    const { messageId } = await sendMessage(server, {
      from,
      to,
      subject: input.subject,
      htmlBody: input.htmlBody,
      plainBody: input.plainBody || stripHtml(input.htmlBody || ""),
      replyTo: input.replyTo || mailbox.address,
      trackOpens: true,
      trackClicks: true,
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
