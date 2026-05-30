/**
 * RecruiterOS · ATS
 * Vendor selection. Loxo is verified; the rest are placeholders that share the
 * Loxo behavior so the engine runs against any selection until specced.
 */

import { LoxoAdapter } from "./loxo";
import type { AtsAdapter, AtsVendor } from "./types";

export * from "./types";
export { LoxoAdapter };

/** Object-mapping reference, surfaced for the ATS settings UI. */
export const LOXO_OBJECT_MAP = [
  { concept: "BD prospect", object: "Person + list 'BD Prospects'", how: "POST /people/update_by_email" },
  { concept: "Target company", object: "Company", how: "dynamic fields: icp_match, active_signals, signal_score" },
  { concept: "BD opportunity", object: "Deal", how: "one per pitch; convert to Job when signed" },
  { concept: "Candidate", object: "Person + list 'Candidates'", how: "tag source=outbound" },
  { concept: "Candidate in mandate", object: "Candidate (Person<->Job)", how: "POST /jobs/{id}/apply" },
  { concept: "Activity (any touch)", object: "person_event", how: "POST /people/{id}/person_events" },
  { concept: "Mandate", object: "Job", how: "required: job_type_id, company_id" },
  { concept: "Placement", object: "Placement", how: "triggers billing" },
] as const;

export const ATS_VENDORS: { vendor: AtsVendor; label: string; status: "verified" | "placeholder" }[] = [
  { vendor: "loxo", label: "Loxo", status: "verified" },
  { vendor: "bullhorn", label: "Bullhorn", status: "placeholder" },
  { vendor: "crelate", label: "Crelate", status: "placeholder" },
  { vendor: "jobadder", label: "JobAdder", status: "placeholder" },
  { vendor: "recruiterflow", label: "Recruiterflow", status: "placeholder" },
  { vendor: "greenhouse", label: "Greenhouse", status: "placeholder" },
  { vendor: "lever", label: "Lever", status: "placeholder" },
  { vendor: "custom", label: "Other / Custom", status: "placeholder" },
];

let singleton: AtsAdapter | null = null;

/** The active ATS adapter (defaults to Loxo). */
export function getAts(): AtsAdapter {
  if (!singleton) singleton = new LoxoAdapter();
  return singleton;
}

/** Swap the active adapter (e.g. from the ATS settings screen). */
export function setAts(adapter: AtsAdapter): void {
  singleton = adapter;
}
