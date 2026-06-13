/**
 * RecruitersOS · ATS
 * The system-of-record adapter contract.
 *
 * Loxo is the primary, fully-specced integration; Bullhorn / Crelate / JobAdder /
 * Recruiterflow / Greenhouse / Lever are selectable but stubbed. Every module
 * writes through this interface, so swapping ATS is one `getAts()` change.
 */

export type AtsVendor =
  | "loxo"
  | "bullhorn"
  | "crelate"
  | "jobadder"
  | "recruiterflow"
  | "greenhouse"
  | "lever"
  | "custom";

/** A person_event pushed for every touch / status change. */
export interface AtsPersonEvent {
  personRef: string;          // ATS person id, or email when id unknown
  activityType: string;       // e.g. "Discovery Call Booked", "Email Sent"
  channel: string;
  note: string;
  at: string;
}

export interface AtsAdapter {
  vendor: AtsVendor;
  /** Create or update a person by email; returns the ATS person id. */
  upsertPersonByEmail(email: string, fields: Record<string, unknown>): Promise<string>;
  /** Log an activity; returns the ATS event id. */
  pushPersonEvent(ev: AtsPersonEvent): Promise<string>;
  /** Tag a person ("engaged", "advocate", "suppress-signals"). */
  tagPerson(personRef: string, tag: string): Promise<void>;
  /** Advance a deal stage (BD: Discovery -> Qualification -> Proposal -> Won). */
  advanceDeal(personRef: string, stage: string): Promise<void>;
  /** Add to the ATS-level do-not-contact list. */
  addDoNotContact(personRef: string): Promise<void>;
}
