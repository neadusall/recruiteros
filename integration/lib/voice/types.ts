/**
 * RecruiterOS · Voice Drops · Domain types
 *
 * Voice Drops is the compliant landline/VoIP voicemail-outreach motion: dial a
 * verified BUSINESS direct line, use Telnyx Premium AMD to detect the voicemail,
 * and drop a personalized 15-25s message assembled from a templated script with
 * the recipient's first name and role spliced in. Cell/mobile numbers are NEVER
 * dialed — they are classified out before a campaign runs.
 *
 * Compliance is modeled as first-class state, not an afterthought:
 *  - every campaign carries a consent attestation + the operator's own consented
 *    cloned voice,
 *  - every lead is dialed only inside its OWN local-time window (timezone derived
 *    from the lead's location), bounded by a hard TCPA-safe envelope,
 *  - every attempt records an auditable outcome.
 *
 * Used by both motions (BD + Recruiting); each campaign is tagged with its motion.
 */

import type { Motion } from "../core/types";
import type { LineType } from "../signals/phoneClassify";
import type { VoiceProvider } from "./provider";

/** The auditable result of a single dial attempt. */
export type DropOutcome =
  | "queued"               // imported, awaiting its local compliance window
  | "scheduled"            // in window soon / next eligible window computed
  | "dialing"              // call placed, AMD pending
  | "voicemail_delivered"  // the personalized VM actually played to completion on a machine
  | "human_answered"       // a person picked up; honest identifier played, then ended
  | "no_answer"            // rang out / no voicemail
  | "failed"               // dial/synthesis error
  | "filtered_mobile"      // never dialed: classified mobile/cell (or toll-free)
  | "suppressed";          // DNC / opt-out / frequency cap

/** Outcomes that mean a real, billable voice minute was spent dialing. */
export const DIALED_OUTCOMES: DropOutcome[] = [
  "voicemail_delivered", "human_answered", "no_answer",
];

/**
 * The operator's honest identification — used as the human-answer script and as
 * the identity stated in every voicemail. This is truthful self-identification
 * (real name + real firm); it is NOT caller-ID spoofing or evasion.
 */
export interface VoicePersona {
  /** First name stated on the call, e.g. "Ryan". */
  agentName: string;
  /** Firm stated on the call, e.g. "Executive Search". */
  agentCompany: string;
  /**
   * Closing line played when a human says it's not the target / doesn't engage,
   * e.g. "Sorry, wrong number. Thanks." Honest, brief sign-off, then hang up.
   */
  signoff: string;
}

/**
 * The local-time window a lead may be dialed in, in the LEAD's own timezone.
 * Default 19:00-21:00 (7-9 PM): the late-evening slot where the line rolls
 * straight to voicemail. The engine additionally clamps every window to a hard
 * TCPA-safe envelope (see HARD_WINDOW) so a misconfiguration can't dial at an
 * unlawful hour.
 */
export interface ComplianceWindow {
  /** Local start hour, 0-23 inclusive. Default 19 (7 PM). */
  startHour: number;
  /** Local end hour, 0-23 exclusive. Default 21 (9 PM). */
  endHour: number;
}

/** One person on a Voice Drops list. Only landline/VoIP leads are ever dialed. */
export interface VoiceLead {
  id: string;
  firstName: string;
  fullName?: string;
  /** Job/title spliced into the script's {role} slot. */
  role?: string;
  company?: string;
  /** The number we dial. Must be landline/VoIP — mobiles are filtered out. */
  phone: string;
  /** Telnyx-classified line type (mobile leads are filtered, never dialed). */
  lineType: LineType;
  /** Free-text location (e.g. "Salt Lake City, UT") used to derive timezone. */
  location?: string;
  /** Resolved IANA timezone (e.g. "America/Denver"), or undefined if unknown. */
  timezone?: string;
  outcome: DropOutcome;
  attempts: number;
  lastAttemptAt?: string;
  /** Telnyx call_control_id of the most recent attempt. */
  callControlId?: string;
  /** Link back to a RecruiterOS Prospect when imported from a saved list. */
  prospectId?: string;
  /** Per-lead voicemail script (BD weekly waves set a unique, value-first script
   *  each week). When present it OVERRIDES the campaign's scriptTemplate for this
   *  lead, so each wave's drop is different. Still merge-templated + cloned + gated. */
  customScript?: string;
}

/** Consent for one cloned voice — the operator's OWN voice, captured on record. */
export interface VoiceConsent {
  id: string;
  workspaceId: string;
  /** Whose voice this is (must match the persona agentName for a campaign). */
  agentName: string;
  /** Which TTS vendor this voice id belongs to (default elevenlabs). */
  provider?: VoiceProvider;
  /** Provider voice id — pasted by the user (bring-your-own-voice). */
  voiceId?: string;
  /** Where the recorded consent clip is stored. */
  consentClipUrl?: string;
  /** The exact consent statement the operator recorded. */
  statement: string;
  /** Signed-in user who attested, and when. */
  attestedBy: string;
  attestedAt: string;
}

/**
 * A reusable, templated voicemail script. The body uses {first_name}, {role},
 * and {company} merge slots, exactly like an email merge. Surfaces in the
 * Campaign Sequences Library as a reusable voice asset.
 */
export interface VoiceScript {
  id: string;
  workspaceId: string;
  motion: Motion;
  name: string;
  /** Templated VM body, e.g. "Hi {first_name}, Ryan with Executive Search...". */
  template: string;
  /** Cloned voice this script renders in (defaults to the campaign's voice). */
  voiceId?: string;
  createdAt: string;
  updatedAt: string;
}

/** A Voice Drops campaign — the unit of work, in BD or Recruiting. */
export interface VoiceCampaign {
  id: string;
  workspaceId: string;
  motion: Motion;
  name: string;
  status: "draft" | "scheduled" | "running" | "paused" | "done";
  persona: VoicePersona;
  /** Templated VM body ({first_name}/{role}/{company}). */
  scriptTemplate: string;
  /** Cloned voice used to render the drop (operator's consented voice). */
  voiceId?: string;
  /** TTS vendor for voiceId (default elevenlabs). */
  voiceProvider?: VoiceProvider;
  /** Approved 10DLC / Telnyx number dialed FROM (one consistent caller-ID). */
  callerId: string;
  /** Local-time dial window per lead (default 7-9 PM). */
  window: ComplianceWindow;
  /** Max dials per run. */
  dailyCap: number;
  /** Minimum days between attempts to one lead (no rapid re-dialing). */
  frequencyCapDays: number;
  /**
   * TEST MODE: when true, the dial tick ignores the per-lead local-time window
   * (and the unresolved-timezone skip) so a campaign can be exercised end-to-end
   * at any hour. Every OTHER gate still holds — line-type filter, consent
   * attestation, frequency/daily caps, dry-run safety. Off for real campaigns;
   * the loud UI badge exists so it's never left on by accident. */
  testMode?: boolean;
  /* ---- compliance gates (all must be satisfied before launch) ---- */
  /** Operator attested a lawful basis (consent / business relationship). */
  consentAttested: boolean;
  consentAttestedBy?: string;
  consentAttestedAt?: string;
  /* ---- rollups ---- */
  leadCount: number;
  filteredMobileCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Input accepted by upsertCampaign (server fills workspace/timestamps/rollups). */
export interface VoiceCampaignInput {
  id?: string;
  motion?: Motion;
  name?: string;
  status?: VoiceCampaign["status"];
  persona?: Partial<VoicePersona>;
  scriptTemplate?: string;
  voiceId?: string;
  voiceProvider?: VoiceProvider;
  callerId?: string;
  window?: Partial<ComplianceWindow>;
  dailyCap?: number;
  frequencyCapDays?: number;
  consentAttested?: boolean;
  testMode?: boolean;
}

/** Defaults applied to a new persona / window when the operator omits them. */
export const DEFAULT_PERSONA: VoicePersona = {
  agentName: "Ryan",
  agentCompany: "Executive Search",
  signoff: "Sorry, wrong number. Thanks.",
};

export const DEFAULT_WINDOW: ComplianceWindow = { startHour: 19, endHour: 21 };
