/**
 * RecruitersOS · Senders (recruiter-owned SMTP inbox pools)
 *
 * A portal (workspace) holds hundreds of individual sending inboxes ("Email IDs").
 * Each inbox is owned by a recruiter (a team member) and sends over its OWN SMTP
 * credentials — your own SMTP server for the RecruitersOS portal, Sending.ac for
 * the Lume portal, etc. Warm-up is handled EXTERNALLY (Smartlead.ai); here we only
 * track a daily send cap + status so we never out-send what Smartlead is ramping.
 *
 * Distinct from lib/sending/* (the self-hosted Postal MTA stack). This module is
 * the "bring your own SMTP inboxes, rotate per recruiter" path.
 */

export type SenderProvider = "own-smtp" | "sending-ac" | "google" | "outlook" | "other";
export type SenderStatus = "active" | "warming" | "paused" | "error";

export interface SenderInbox {
  id: string;
  workspaceId: string;        // the portal this inbox was uploaded into (isolation boundary)
  ownerId?: string;           // recruiter (team member userId) who owns this inbox
  ownerName?: string;         // denormalized recruiter name, for fast list rendering

  email: string;              // the sending address / "Email ID"
  displayName?: string;       // From-name on outgoing mail

  provider: SenderProvider;

  // SMTP — required to send
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;        // true = implicit TLS (465); false = STARTTLS (587/25)
  smtpUser: string;
  smtpPassEnc: string;        // AES-256-GCM at rest; NEVER returned to the client

  // IMAP — optional, for reply sync later
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  imapPassEnc?: string;

  // Sending controls (Smartlead warms; we cap)
  dailyCap: number;
  sentToday: number;
  status: SenderStatus;
  warmExternal: boolean;      // warmed by Smartlead.ai (informational flag)

  // Health / counters
  sent: number;
  bounced: number;
  lastSendAt?: string;
  lastError?: string;
  /** Consecutive transport failures; 3 flips the inbox to "error" until the
   *  auth sweep proves the login again. Reset by any clean send. */
  errorStreak?: number;
  pausedReason?: string;

  // Reply-sync cursor (lib/senders/replySync): IMAP UID high-water mark so each
  // poll only reads mail that arrived since the last one.
  replySyncUid?: number;
  replySyncAt?: string;

  // Health guard (set ONLY by lib/senders/healthGuard; operator pauses never set autoHold)
  autoHold?: boolean;         // the guard (not an operator) paused this inbox
  autoHoldAt?: string;
  autoHoldReason?: string;
  recoverStreak?: number;     // consecutive healthy checks while held
  warmupRepPct?: number;      // last synced external warm-up reputation %
  warmupStatus?: string;      // last synced external warm-up status
  healthCheckedAt?: string;
  guardBaseSent?: number;     // bounce window baseline (reset on each revive)
  guardBaseBounced?: number;

  // Onboarding audit (set ONLY by lib/senders/onboarding): every imported Email ID
  // is vetted (SMTP login, DNS posture, blocklists) within one maintenance tick.
  onboardAuditAt?: string;
  onboardProblems?: string[]; // empty/absent = clean bill

  createdAt: string;
  updatedAt: string;
}

/** Client-safe shape: every field EXCEPT the encrypted secrets. */
export interface SenderInboxPublic {
  id: string;
  workspaceId: string;
  ownerId?: string;
  ownerName?: string;
  email: string;
  displayName?: string;
  provider: SenderProvider;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  hasImap: boolean;
  dailyCap: number;
  sentToday: number;
  remaining: number;
  /** False = no SMTP credentials stored (OAuth mailbox managed upstream); the
   *  rotation never picks it, it is tracked-and-counted only. */
  hasSmtpCreds: boolean;
  status: SenderStatus;
  warmExternal: boolean;
  sent: number;
  bounced: number;
  lastSendAt?: string;
  lastError?: string;
  pausedReason?: string;
  autoHold?: boolean;
  autoHoldReason?: string;
  warmupRepPct?: number;
  warmupStatus?: string;
  createdAt: string;
  updatedAt: string;
}

/** A recruiter's pool summary (for the assignment UI). */
export interface RecruiterPool {
  ownerId: string;
  ownerName: string;
  inboxes: number;
  active: number;
  dailyCapacity: number;     // sum of dailyCap across active inboxes
  remainingToday: number;    // sum of (dailyCap - sentToday) across active inboxes
}
