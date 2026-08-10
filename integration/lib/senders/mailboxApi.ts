/**
 * RecruitersOS · Senders · Sending.ac Mailbox API transport
 *
 * The Sending.ac lume fleet is ~900 Microsoft 365 mailboxes connected to Smartlead over
 * OAuth, so they arrive here with NO SMTP password and the SMTP send hop can never sign
 * in as them. Sending.ac's answer is the Mailbox API: a Microsoft Graph drop-in proxy
 * that sends and reads mail AS any mailbox you own, authenticated by ONE account-level
 * key plus the mailbox's own address. No per-mailbox credential ever changes hands, which
 * is why no CSV export or credential sync was ever going to work for this fleet: the
 * model does not use per-box logins at all.
 *
 * We hold the mailbox addresses already (they imported credential-less from the warm-up
 * sync). This module turns those addresses into a working send path.
 *
 * Scope, deliberately narrow (the proxy runs a strict allow-list; everything else 404s):
 *   POST /azure/v1.0/users/{email}/sendMail          send as {email}
 *   GET  /azure/v1.0/users/{email}/messages          read {email}'s mail (reply sync)
 *
 * Only Microsoft 365 mailboxes work, which is exactly the lume Outlook fleet. The tal
 * fleet is real SMTP (inboxalways) and keeps its own SMTP path; this transport is chosen
 * only for a `sending-ac` inbox that has no stored SMTP password (see canSendViaMailboxApi).
 *
 * The key MUST be a live Mailbox-scope key (sk_live_…). A Provisioning or sandbox key is
 * rejected with 403 "This API key is not a Mailbox API key".
 */

import type { SenderInbox } from "./types";
import type { SmtpMessage, SmtpResult } from "./smtp";

const DEFAULT_BASE = "https://api.customers.ac/api/mailbox/v1alpha1";

/** 60 req/min/key upstream. Pace one call at a time to ~54/min so a send burst across
 *  the fleet never trips the limiter mid-run. */
const MIN_GAP_MS = 1_100;

export function mailboxApiKey(): string {
  return (process.env.SENDINGAC_MAILBOX_API_KEY || "").trim();
}

export function mailboxApiConfigured(): boolean {
  return mailboxApiKey().startsWith("sk_");
}

/** Graph surface base, `/api` prefix included (dropping it 404s everything). */
function graphBase(): string {
  const base = (process.env.SENDINGAC_MAILBOX_API_BASE || DEFAULT_BASE).trim().replace(/\/+$/, "");
  return `${base}/azure/v1.0`;
}

/**
 * Does this inbox send through the Mailbox API rather than SMTP?
 *
 * True only for a Sending.ac mailbox with NO stored SMTP password while a Mailbox key is
 * configured. That single condition separates the two fleets cleanly: the lume MS365
 * boxes (credential-less) route here; the tal boxes (real SMTP logins stored) never do,
 * so a tal address is never handed to a proxy that would 404 on it.
 */
export function canSendViaMailboxApi(m: Pick<SenderInbox, "provider" | "smtpPassEnc">): boolean {
  return mailboxApiConfigured() && m.provider === "sending-ac" && !m.smtpPassEnc;
}

let lastCallAt = 0;
async function pace(): Promise<void> {
  const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/** Build Graph's sendMail body from our transport-neutral message. */
function toGraphMessage(from: SenderInbox, msg: SmtpMessage) {
  const html = msg.html && msg.html.trim();
  const body = html
    ? { contentType: "HTML", content: html }
    : { contentType: "Text", content: msg.text || "" };

  // Graph only accepts internet headers whose name starts with `x-` on sendMail, so a
  // Message-ID / In-Reply-To cannot be forced here; Microsoft assigns the Message-ID.
  // Reply threading therefore rides on subject + recipient, not RFC headers, for this
  // fleet. Any caller x-* headers are forwarded; standard headers are dropped rather
  // than rejected by the API.
  const internetMessageHeaders = Object.entries(msg.headers || {})
    .filter(([k]) => /^x-/i.test(k))
    .map(([name, value]) => ({ name, value: String(value) }));

  const message: Record<string, unknown> = {
    subject: msg.subject,
    body,
    toRecipients: [{ emailAddress: { address: msg.to } }],
  };
  if (from.displayName) message.from = { emailAddress: { address: from.email, name: from.displayName } };
  if (msg.replyTo) message.replyTo = [{ emailAddress: { address: msg.replyTo } }];
  if (internetMessageHeaders.length) message.internetMessageHeaders = internetMessageHeaders;
  return { message, saveToSentItems: true };
}

/**
 * Send one message AS the given mailbox via the Mailbox API. Never throws.
 *
 * 202 = accepted (success). A 502 is ambiguous - Microsoft may already have sent the
 * message - so per Sending.ac's guidance we NEVER report it as a clean failure that would
 * invite an automatic resend; we surface it as sent-but-unconfirmed so the prospect is
 * not mailed twice. 429/503 are genuine "try later" and come back as failures the cadence
 * retries on its next tick.
 */
export async function sendViaMailboxApi(m: SenderInbox, msg: SmtpMessage): Promise<SmtpResult> {
  const key = mailboxApiKey();
  if (!key) return { ok: false, error: "SENDINGAC_MAILBOX_API_KEY is not set" };

  const url = `${graphBase()}/users/${encodeURIComponent(m.email)}/sendMail`;
  await pace();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(toGraphMessage(m, msg)),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (res.status === 202 || res.status === 200) return { ok: true };

  // Ambiguous: do not resend. Count it as sent so the prospect is not double-mailed.
  if (res.status === 502) return { ok: true, error: "mailbox_api_502_ambiguous" };

  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body?.error?.message) detail = `${body.error.code || res.status}: ${body.error.message}`;
  } catch { /* non-JSON body: the status line stands */ }
  return { ok: false, error: detail };
}

export interface MailboxApiMessage {
  id: string;
  subject?: string;
  from?: string;
  receivedDateTime?: string;
  bodyPreview?: string;
}

/**
 * Read recent messages for one mailbox (reply sync). Returns [] on any failure so a
 * caller loop over the fleet is never derailed by one bad mailbox. `$select` is always
 * sent because the default projection carries full bodies and dominates the payload.
 */
export async function listMailboxApiMessages(email: string, top = 25): Promise<MailboxApiMessage[]> {
  const key = mailboxApiKey();
  if (!key) return [];
  const url = new URL(`${graphBase()}/users/${encodeURIComponent(email)}/messages`);
  url.searchParams.set("$select", "id,subject,from,receivedDateTime,bodyPreview");
  url.searchParams.set("$top", String(Math.min(Math.max(top, 1), 100)));
  url.searchParams.set("$orderby", "receivedDateTime desc");
  await pace();
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { value?: Array<Record<string, any>> };
    return (data.value || []).map((m) => ({
      id: String(m.id),
      subject: m.subject,
      from: m.from?.emailAddress?.address,
      receivedDateTime: m.receivedDateTime,
      bodyPreview: m.bodyPreview,
    }));
  } catch {
    return [];
  }
}

export interface MailboxApiPing {
  ok: boolean;
  configured: boolean;
  keyHint: string;
  base: string;
  status?: number;
  error?: string;
}

/**
 * Cheap key check: a GET mailFolders on one real mailbox. A live Mailbox key returns 200;
 * a Provisioning/sandbox key returns 403 with a clear message; an address that is not
 * ours returns 404. The caller passes an address it believes is in the account.
 */
export async function pingMailboxApi(sampleEmail: string): Promise<MailboxApiPing> {
  const key = mailboxApiKey();
  const base = graphBase();
  const keyHint = key ? `${key.slice(0, 8)}…${key.slice(-4)}` : "";
  if (!key) return { ok: false, configured: false, keyHint, base, error: "SENDINGAC_MAILBOX_API_KEY is not set" };
  await pace();
  try {
    const res = await fetch(`${base}/users/${encodeURIComponent(sampleEmail)}/mailFolders?$top=1`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return { ok: true, configured: true, keyHint, base, status: res.status };
    let error = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body?.error?.message) error = `${body.error.code || res.status}: ${body.error.message}`;
    } catch { /* keep status line */ }
    return { ok: false, configured: true, keyHint, base, status: res.status, error };
  } catch (e) {
    return { ok: false, configured: true, keyHint, base, error: e instanceof Error ? e.message : String(e) };
  }
}
