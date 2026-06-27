/**
 * RecruitersOS · Senders · SMTP send hop
 * Sends a single message through one inbox's own SMTP credentials (nodemailer).
 * Covers your own SMTP server AND Sending.ac — both are just SMTP endpoints.
 */
import nodemailer from "nodemailer";
import { decryptSecret } from "./crypto";
import type { SenderInbox } from "./types";

export interface SmtpMessage {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export interface SmtpResult { ok: boolean; messageId?: string; error?: string; }

function transportFor(m: SenderInbox) {
  return nodemailer.createTransport({
    host: m.smtpHost,
    port: m.smtpPort,
    secure: m.smtpSecure,
    auth: { user: m.smtpUser, pass: decryptSecret(m.smtpPassEnc) },
  });
}

/** Send one message via the given inbox. Never throws — returns {ok}. */
export async function sendViaInbox(m: SenderInbox, msg: SmtpMessage): Promise<SmtpResult> {
  try {
    const t = transportFor(m);
    const from = m.displayName ? `"${m.displayName.replace(/"/g, "")}" <${m.email}>` : m.email;
    const info = await t.sendMail({
      from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      replyTo: msg.replyTo,
      headers: msg.headers,
    });
    return { ok: true, messageId: info.messageId };
  } catch (e: any) {
    return { ok: false, error: e?.message || "smtp_send_failed" };
  }
}

/** Verify an inbox's SMTP login (used by the "test" action). */
export async function verifyInbox(m: SenderInbox): Promise<SmtpResult> {
  try {
    await transportFor(m).verify();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || "smtp_verify_failed" };
  }
}
