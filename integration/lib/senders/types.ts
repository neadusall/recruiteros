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
  pausedReason?: string;

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
  status: SenderStatus;
  warmExternal: boolean;
  sent: number;
  bounced: number;
  lastSendAt?: string;
  lastError?: string;
  pausedReason?: string;
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
