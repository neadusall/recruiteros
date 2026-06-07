/**
 * RecruiterOS · Sending infrastructure
 * The owned cold-email stack: sending domains, mailboxes, MTA servers, and the
 * exact DNS record set each domain needs for deliverability.
 *
 * Design goal: the owner feeds in bare domain names; everything else
 * (DKIM keys, the full record set, PTR/rDNS) is generated and pushed to Hetzner
 * automatically. Nothing is hand-entered into a DNS console.
 *
 * See docs/design/self-hosted-email-infrastructure.md for the full plan.
 */

/** A DNS record we WANT to exist for a sending domain. */
export type DnsRecordType = "MX" | "TXT" | "A" | "CNAME";

/** What a record is for — drives generation + the verify checklist. */
export type DnsPurpose =
  | "mta_a"        // A record for the MTA host (mail.<domain> -> IP)
  | "mx"           // MX -> MTA host
  | "spf"          // TXT root: v=spf1 ...
  | "dkim"         // TXT <selector>._domainkey
  | "dmarc"        // TXT _dmarc
  | "return_path"  // CNAME bounce/return-path (Postal "rp")
  | "tracking"     // CNAME custom open/click tracking host
  | "bimi";        // TXT default._bimi (optional, needs VMC)

export interface DesiredRecord {
  type: DnsRecordType;
  /** Record name as a host label relative to the zone ("@" = root). */
  name: string;
  value: string;
  ttl: number;
  purpose: DnsPurpose;
  /** Optional priority for MX. */
  priority?: number;
  /** True once observed live in DNS (set by verify). */
  present?: boolean;
  /** Hetzner DNS record id once created (for reconcile/update). */
  providerRecordId?: string;
}

export type DomainStatus =
  | "pending"       // just added, nothing provisioned yet
  | "provisioning"  // creating zone + writing records
  | "awaiting_ns"   // records written; waiting for the registrar NS to point at Hetzner
  | "verifying"     // NS delegated; polling until all records resolve
  | "active"        // all records live + verified; safe to send (after warmup)
  | "error"
  | "paused";       // governor pulled it (reputation)

export interface SendingDomain {
  id: string;
  workspaceId: string;
  domain: string;                 // e.g. "recruitco.io"
  serverId?: string;              // MTA server hosting it
  status: DomainStatus;

  // Auth material (generated in-app, never hand-entered)
  dkimSelector: string;           // e.g. "ros2026a"
  dkimPublicKey?: string;         // base64 SPKI DER, goes in the DKIM TXT
  dkimPrivateKeyPem?: string;     // secret; configured into the MTA (Postal)

  trackingHost?: string;          // "track.recruitco.io"
  dmarcRua?: string;              // mailto: for aggregate reports

  // Hetzner DNS
  zoneId?: string;                // Hetzner DNS zone id
  nameservers?: string[];         // NS to set at the registrar (the one manual step)
  records: DesiredRecord[];       // desired + observed

  // Deliverability
  metrics?: DeliveryMetrics;
  reputation?: Reputation;
  pausedReason?: string;          // why the governor paused it

  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
  lastError?: string;
}

export type ServerStatus = "pending" | "provisioning" | "installing" | "active" | "error";

export interface MtaServer {
  id: string;
  workspaceId: string;
  provider: "hetzner";
  name: string;                   // hetzner server name
  hostname: string;               // "mail.<primary domain>" — the MX target + PTR
  hcloudServerId?: number;        // Hetzner Cloud numeric id
  ip?: string;                    // public IPv4
  ptr?: string;                   // reverse DNS set on the IP (== hostname)
  serverType?: string;            // e.g. "cx22"
  location?: string;              // e.g. "ash" (US) / "nbg1"
  status: ServerStatus;

  // Postal MTA (set after the box boots + Postal is configured)
  postalHost?: string;            // https://<mta host> (Postal web/API)
  postalApiKey?: string;          // X-Server-API-Key (secret)
  postalReady?: boolean;          // creds present + last send/ping ok

  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

/** Rolling deliverability counters for a domain (or mailbox). */
export interface DeliveryMetrics {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  opened: number;
  /** Window start for the rolling rates (ISO). */
  since: string;
}

/** Reputation snapshot from Postmaster / SNDS. */
export interface Reputation {
  source: "postmaster" | "snds" | "computed";
  tier?: "high" | "medium" | "low" | "bad";   // Google domain/IP reputation
  spamRatePct?: number;                          // user-reported spam %
  authPct?: number;                              // SPF/DKIM/DMARC pass %
  trapHits?: number;                             // SNDS spam-trap hits
  at: string;
}

export type MailboxStatus = "warming" | "active" | "paused";

export interface Mailbox {
  id: string;
  workspaceId: string;
  domainId: string;
  address: string;                // "ryan@recruitco.io"
  displayName?: string;
  dailyCap: number;               // current cap (ramps during warmup)
  sentToday: number;
  warmupDay: number;              // 0..N ramp progress
  status: MailboxStatus;
  pausedReason?: string;
  // lifetime counters
  sent: number;
  bounced: number;
  complained: number;
  createdAt: string;
  updatedAt: string;
}

/** A suppressed recipient — never contacted again (compliance + reputation). */
export interface SuppressionEntry {
  email: string;
  reason: "bounce" | "complaint" | "unsubscribe" | "manual";
  source?: string;
  at: string;
}

/** A recent delivery event, kept capped for the UI feed. */
export interface SendEvent {
  id: string;
  at: string;
  type: "sent" | "delivered" | "bounce" | "complaint" | "open";
  domainId?: string;
  mailboxId?: string;
  to?: string;
  detail?: string;
}

/** A seed inbox used for placement testing. */
export interface SeedAccount {
  id: string;
  provider: "gmail" | "outlook" | "yahoo" | "other";
  address: string;
  /** IMAP creds for an automated placement reader (optional; else manual/webhook). */
  imapHost?: string;
  imapUser?: string;
  imapPass?: string;
}

export type Placement = "inbox" | "promotions" | "spam" | "missing" | "pending";

export interface SeedResult {
  seedId: string;
  provider: string;
  address: string;
  placement: Placement;
}

export interface SeedTest {
  id: string;
  workspaceId: string;
  domainId: string;
  mailboxId?: string;
  at: string;
  status: "sending" | "complete";
  results: SeedResult[];
  /** % of seeds that landed in inbox (or promotions), once complete. */
  inboxRatePct?: number;
}
