/**
 * RecruitersOS · Senders · Sending.ac Partner API credential sync
 *
 * The one job: give every Sending.ac mailbox the SMTP password it needs to send from
 * this platform, and the IMAP password it needs for reply sync.
 *
 * Why this exists alongside `./fleetSync`: the Smartlead mirror knows the fleet EXISTS
 * (it warms it) but carries no SMTP password for the OAuth-provisioned M365 mailboxes,
 * so the whole Sending.ac pool imported credential-less and `pickSender` skipped every
 * row. Capacity that showed on the Send Queue gauge could never actually be spent. The
 * Partner API is the only source that hands over those passwords.
 *
 * How the two syncs cooperate:
 *   - fleetSync  (Smartlead)  - discovers mailboxes, warm-up reputation, health.
 *   - this sync  (Partner API) - attaches real IMAP/SMTP credentials to them.
 * Both call `addInbox`, which merges by (workspace, email) and preserves the operator's
 * status, recruiter assignment and counters. Order does not matter and running either
 * twice changes nothing, so both are safe on a timer.
 *
 * Credential-less by design, still: a mailbox upstream that is not yet `active` has no
 * credentials to give. Those import exactly as before (tracked, counted, not rotated)
 * and pick up their credentials on a later run once provisioning finishes. A run that
 * cannot reach the API leaves every stored credential untouched rather than blanking it
 * - losing 1,450 working logins to one bad network minute is the failure mode this
 * module is most careful to avoid.
 */

import { addInbox, findInboxByEmail, relocateInbox, setStatus } from "./store";
import { buildPortalRouter } from "./fleetSync";
import {
  sendingAcConfigured,
  sendingAcIsSandbox,
  sendingAcKeyHint,
  listSenders,
  listMailboxes,
  SendingAcApiError,
  type SendingAcMailbox,
} from "./sendingAcApi";
import type { SenderStatus } from "./types";

export interface SendingAcSyncReport {
  configured: boolean;
  sandbox: boolean;
  keyHint: string;
  /** Upstream senders walked. */
  senders: number;
  /** Mailboxes seen upstream. */
  mailboxes: number;
  /** New rows created in a portal pool. */
  imported: number;
  /** Existing rows refreshed. */
  updated: number;
  /** Rows that now hold a real SMTP password (i.e. can actually send). */
  credentialed: number;
  /** Upstream mailboxes not yet active, so no credentials to attach. */
  pending: number;
  /** Mailboxes whose domain has no portal home. */
  skippedNoWorkspace: number;
  /** Mailboxes moved out of a portal they no longer belong to. */
  relocated: number;
  /** True if a list response was cut short by the page guard (coverage incomplete). */
  truncated: boolean;
  byWorkspace: Record<string, number>;
  errors: string[];
  at: string;
}

function emptyReport(): SendingAcSyncReport {
  return {
    configured: false, sandbox: false, keyHint: "",
    senders: 0, mailboxes: 0, imported: 0, updated: 0,
    credentialed: 0, pending: 0, skippedNoWorkspace: 0, relocated: 0,
    truncated: false, byWorkspace: {}, errors: [], at: new Date().toISOString(),
  };
}

/** Implicit TLS (465, "SSL/TLS") vs STARTTLS. Trust the port when the label is absent
 *  or unrecognised, since the port is what the transport actually dials. */
function isImplicitTls(encryption: string | undefined, port: number | undefined): boolean {
  const e = (encryption || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (e === "SSLTLS") return true;
  if (e === "STARTTLS" || e === "NONE") return false;
  return Number(port) === 465;
}

/** Import one upstream mailbox into its portal pool. Returns what changed. */
async function importMailbox(
  mb: SendingAcMailbox,
  routePortal: (domain: string) => string | null,
  report: SendingAcSyncReport,
): Promise<void> {
  const email = (mb.email || "").toLowerCase().trim();
  if (!email) return;
  const domain = email.split("@")[1] || "";
  const wsId = routePortal(domain);
  if (!wsId) { report.skippedNoWorkspace++; return; }

  // Portal routing can change under a mailbox (a new tenant, a widened brand match).
  // Clear any copy left in the old home first, or the correction reads as a duplicate
  // instead of a move - same reasoning as the Smartlead sync.
  try {
    if (await relocateInbox(wsId, email)) report.relocated++;
  } catch { /* one row; the add below still lands it in the right pool */ }

  const smtp = mb.credentials?.smtp;
  const imap = mb.credentials?.imap;
  const hasSmtp = !!(smtp?.host && smtp?.password);
  if (!hasSmtp) report.pending++; else report.credentialed++;

  const existing = await findInboxByEmail(wsId, email);

  // A working login is never downgraded to nothing: addInbox keeps the stored password
  // (with its host/port/user) whenever the incoming row carries none, so a mailbox that
  // is mid-provisioning upstream, or a partial response, cannot break a sender that was
  // fine a minute ago. That guard is why this passes `smtpPass: ""` without ceremony.

  // An upstream suspension is a real signal and should stop sends; otherwise leave the
  // operator's status alone, defaulting a brand-new row to "warming".
  const upstreamSuspended = mb.status === "suspended" || mb.status === "deprovisioned";
  const status: SenderStatus = upstreamSuspended ? "paused" : (existing?.status ?? "warming");

  // addInbox merges by (workspace, email) and keeps the original createdAt on update,
  // which matters: the cold-send ramp and the minimum-age gate are both measured from
  // it, so a restamp on every sync would hold the fleet at zero capacity forever.
  const saved = await addInbox(wsId, {
    email,
    displayName: existing?.displayName || mb.display_name || undefined,
    provider: "sending-ac",
    smtpHost: smtp?.host || existing?.smtpHost || "smtp.office365.com",
    smtpPort: smtp?.port || existing?.smtpPort || 587,
    smtpSecure: isImplicitTls(smtp?.encryption, smtp?.port),
    smtpUser: smtp?.username || email,
    smtpPass: smtp?.password || "",
    imapHost: imap?.host || existing?.imapHost,
    imapPort: imap?.port || existing?.imapPort,
    imapUser: imap?.username || email,
    imapPass: imap?.password || undefined,
    status,
    warmExternal: true,
  });

  // Say WHY on an upstream suspension, so the Senders tab shows a cause instead of a
  // silently paused row the operator would otherwise just switch back on.
  if (upstreamSuspended) {
    try {
      await setStatus(wsId, [saved.id], "paused", `Suspended upstream (Sending.ac status: ${mb.status})`);
    } catch { /* the paused status above already stopped sends */ }
  }

  if (existing) report.updated++; else report.imported++;
  report.byWorkspace[wsId] = (report.byWorkspace[wsId] || 0) + 1;
}

/**
 * Pull the whole Sending.ac fleet with credentials and mirror it into the portal pools.
 *
 * Never throws: a per-sender failure is recorded and the walk continues, so one bad
 * sender cannot cost the run every other sender's credentials.
 */
export async function syncSendingAcFleet(): Promise<SendingAcSyncReport> {
  const report = emptyReport();
  report.sandbox = sendingAcIsSandbox();
  report.keyHint = sendingAcKeyHint();
  if (!sendingAcConfigured()) return report;
  report.configured = true;

  let senders: Awaited<ReturnType<typeof listSenders>>;
  try {
    senders = await listSenders();
  } catch (e) {
    // Auth/quota failures are the operator's problem to fix and must be visible, not
    // swallowed into a report that reads like "nothing to do".
    report.errors.push(e instanceof SendingAcApiError ? `${e.code}: ${e.message}` : String(e));
    return report;
  }
  report.senders = senders.length;
  if (!senders.length) return report;

  const routePortal = await buildPortalRouter();

  for (const s of senders) {
    if (s.status === "deprovisioned") continue;
    try {
      const { mailboxes, truncated } = await listMailboxes(s.id, { credentials: true });
      if (truncated) report.truncated = true;
      report.mailboxes += mailboxes.length;
      for (const mb of mailboxes) {
        try {
          await importMailbox(mb, routePortal, report);
        } catch (e) {
          report.errors.push(`${mb.email || mb.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      const label = s.name || s.id;
      report.errors.push(`sender ${label}: ${e instanceof SendingAcApiError ? `${e.code}: ${e.message}` : String(e)}`);
    }
  }

  report.at = new Date().toISOString();
  return report;
}

/* ---- debounced auto-sync (fires from the Senders tab load, at most every 6h) ---- */

const AUTO_EVERY_MS = 6 * 60 * 60 * 1000;
let lastAutoAt = 0;
let inflight: Promise<SendingAcSyncReport> | null = null;

export function maybeAutoSendingAcSync(): void {
  if (!sendingAcConfigured()) return;
  const now = Date.now();
  if (inflight || now - lastAutoAt < AUTO_EVERY_MS) return;
  lastAutoAt = now;
  inflight = syncSendingAcFleet().finally(() => { inflight = null; });
  void inflight.catch(() => {});
}
