/**
 * RecruiterOS · Companies
 *
 * The BD motion's company table. Until now it lived only in the browser's
 * localStorage (assets/js/command.js); this is its durable server shape so a
 * Loxo sync (or any future source) can populate it and it survives a redeploy.
 *
 * Field names mirror what the Companies tab already renders, plus provenance
 * fields for dedupe/re-sync.
 */

export type CompanySource = "loxo" | "csv" | "manual" | "seed";

/** A pipeline status the Companies tab groups by. */
export type CompanyStatus =
  | "uncontacted"
  | "in_progress"
  | "active_opportunity"
  | "current_client"
  | "dead_opportunity"
  | "do_not_prospect";

export interface CompanyRecord {
  id: string;
  workspaceId: string;

  name: string;
  url?: string; // website / domain
  image?: string; // company logo URL (from the ATS/provider), if any
  domain?: string; // normalized hostname, used for dedupe
  location?: string; // "City, State"
  owner?: string; // recruiter / account owner
  type?: string; // "Client", "Prospect", …
  status: CompanyStatus;
  jobs: number; // open roles count (0 until wired)
  tags: string[];

  // Provenance
  source: CompanySource;
  providerId?: string; // the source system's own id (Loxo company id) for re-sync
  raw?: Record<string, string>;

  created?: string; // human "created" date as shown in the tab
  createdAt: string;
  updatedAt: string;
}

/** A normalized company ready to upsert (no id/timestamps yet). */
export type CompanyInput = Omit<CompanyRecord, "id" | "workspaceId" | "createdAt" | "updatedAt">;

export interface CompanyQuery {
  q?: string;
  status?: CompanyStatus;
  source?: CompanySource;
  limit?: number;
  offset?: number;
}
