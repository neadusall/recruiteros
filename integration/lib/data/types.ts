/**
 * RecruitersOS · Data
 * The people-data warehouse: a workspace-scoped table of person records pulled
 * from a licensed external data provider (e.g. ZoomInfo) and held locally so
 * leads can be looked up + enriched without a live provider call every time.
 *
 * A DataRecord is provider-agnostic on purpose. Ingestion can come from:
 *   - a CSV/file the user exported from the provider's own portal (today), or
 *   - the provider's official API once a key is configured (drop-in later).
 * Either way it lands here in the same shape. `raw` keeps the original row so we
 * never lose a field the schema doesn't model yet.
 */

/** Where a record came from — provenance for trust + de-dupe + license audit. */
export type DataSource =
  | "csv"            // imported from a file the user exported from the portal
  | "zoominfo-api"   // pulled via the official ZoomInfo Enterprise API
  | "loxo"           // pulled from the connected Loxo ATS (people -> Candidates)
  | "manual";        // hand-added in the Data tab

/** Verification state of a contact value, when the provider tells us. */
export type ContactStatus = "verified" | "probable" | "unverified" | "invalid";

export interface DataRecord {
  id: string;
  workspaceId: string;

  // Identity
  fullName: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  seniority?: string;

  // Company
  company?: string;
  companyDomain?: string;
  companyId?: string;        // provider's stable company id, if any
  industry?: string;

  // Contact (the enrichment payload that matters)
  email?: string;
  emailStatus?: ContactStatus;
  email2?: string;           // secondary / personal
  phone?: string;            // best mobile/direct
  phoneStatus?: ContactStatus;
  directPhone?: string;
  companyPhone?: string;

  // Web + location
  linkedinUrl?: string;
  image?: string;            // profile photo URL (from the ATS/provider), if any
  city?: string;
  state?: string;
  country?: string;

  // Recruiting context (carried from an ATS/portal export — Loxo, etc.)
  stage?: string;            // pipeline stage: Outbound, Submitted, Interviewing, Longlist…
  tags?: string[];           // free tags / skills from the export
  bio?: string;              // intake notes / candidate summary (long text)
  compensation?: string;     // comp as exported, kept as a display string
  owner?: string;            // recruiter who owns this record
  recordType?: string;       // Candidate, Contact, …
  origin?: string;           // where the export sourced it (LinkedIn, Loxo Source, …)
  lastActivityAt?: string;   // most recent activity timestamp from the export

  // Communication state (from the ATS activity log + our own sends). This is what
  // keeps the app from double-contacting someone the agency is already talking to.
  lastContactedAt?: string;      // most recent REAL communication (email/call/text/linkedin/meeting)
  lastContactChannel?: string;   // email | call | sms | linkedin | meeting
  doNotContact?: boolean;        // ATS-level DNC status/tag, or a local opt-out
  dncReason?: string;            // e.g. "loxo_status", "loxo_tag", "stop_reply"

  // Provenance
  source: DataSource;
  providerId?: string;       // provider's own record id, for re-sync / de-dupe
  /** Original imported row, opaque — nothing in the app depends on its shape. */
  raw?: Record<string, string>;

  createdAt: string;
  updatedAt: string;
  enrichedAt?: string;       // last time we resolved/refreshed contact via the waterfall
}

/** A normalized record ready to upsert (no id/timestamps yet). */
export type DataRecordInput = Omit<DataRecord, "id" | "workspaceId" | "createdAt" | "updatedAt">;

/** Query for listing/searching the warehouse. */
export interface DataQuery {
  q?: string;                // free-text over name/title/company/email
  company?: string;
  hasEmail?: boolean;
  hasPhone?: boolean;
  source?: DataSource;
  limit?: number;
  offset?: number;
}
