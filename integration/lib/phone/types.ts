/**
 * RecruitersOS · Phone · Domain types
 *
 * The browser phone system: Telnyx WebRTC calling in the portal, with recorded
 * calls flowing through an async pipeline (recording -> transcript -> LLM call
 * intelligence). The telephony layer is motion-agnostic (shared lines, shared
 * webhook plumbing); the CALL INTELLIGENCE is per-motion. This phase ships the
 * Business Development phone ("bd"); the Recruiting phone ("recruiting") will
 * plug its own analysis workflow into the same rails later.
 *
 * Design rules:
 *  - Every entity is workspace-scoped and carries the motion it belongs to.
 *  - Structured analysis fields stay queryable (no single opaque JSON blob):
 *    the analysis object is typed, normalized, and versioned.
 *  - AI output and user edits are SEPARATE layers: regeneration replaces the
 *    AI layer, never the user's overrides or their live notes.
 */

import type { Motion } from "../core/types";

/* ============================== infra ============================== */

/**
 * Per-workspace Telnyx wiring for the browser phone, provisioned once via the
 * API (idempotent) and reused for every line/user in the workspace:
 *  - a Call Control application: every PSTN-facing leg lives here so the
 *    server can answer/bridge/record/transcribe and receive webhooks.
 *  - a Credential Connection: the WebRTC registrations (one telephony
 *    credential per user) that browser legs are dialed to.
 */
export interface PhoneInfra {
  workspaceId: string;
  /** Telnyx Call Control application id (connection_id for PSTN legs). */
  appId?: string;
  /** Telnyx Credential Connection id (parent of user WebRTC credentials). */
  credentialConnectionId?: string;
  /** Where this app's webhooks point (recorded for drift detection). */
  webhookUrl?: string;
  provisionedAt?: string;
  lastError?: string;
  updatedAt: string;
}

/* ============================== lines ============================== */

/** A Telnyx phone number connected to the portal phone system. */
export interface PhoneLine {
  id: string;
  workspaceId: string;
  /** E.164 number, e.g. "+13105551234". */
  e164: string;
  /** Telnyx phone-number resource id (from GET /v2/phone_numbers). */
  telnyxNumberId?: string;
  /** Telnyx connection currently routing this number's voice traffic. */
  connectionId?: string;
  /** Operator label, e.g. "BD main line". */
  label: string;
  /** Which phone product this line belongs to. */
  motion: Motion;
  /** Users allowed to place/receive calls on this line (empty = admins only). */
  assignedUserIds: string[];
  /** Inbound routing enabled (number's voice points at our WebRTC connection). */
  inboundEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Per-user phone state: which line their outbound calls present. */
export interface PhoneUserState {
  userId: string;
  workspaceId: string;
  /** Active outbound line (caller ID). Must be a line assigned to the user. */
  activeLineId?: string;
  /** Telnyx telephony-credential id backing this user's WebRTC login. */
  credentialId?: string;
  /** SIP username of that credential (identifies inbound legs for this user). */
  sipUsername?: string;
  updatedAt: string;
}

/* ============================== calls ============================== */

export type CallDirection = "inbound" | "outbound";

/**
 * Lifecycle of the call leg itself (not the intelligence pipeline).
 * ringing -> active -> completed | missed | declined | failed | canceled
 */
export type CallStatus =
  | "ringing"    // outbound dialing or inbound ringing
  | "active"     // media up
  | "held"       // active but on hold
  | "completed"  // ended after being answered
  | "missed"     // inbound, never answered
  | "declined"   // inbound, explicitly declined
  | "canceled"   // outbound, abandoned before answer
  | "failed";    // signaling/network error

/** Post-call intelligence pipeline, status-driven so the UI never blocks. */
export type PipelineStage =
  | "idle"          // nothing to do (no recording, or recording disabled)
  | "recording"     // call ended, waiting for Telnyx to finalize the recording
  | "transcribing"  // recording saved, transcription requested/in flight
  | "analyzing"     // transcript ready, LLM notes being generated
  | "complete"      // analysis stored
  | "failed";       // a stage errored; see pipelineError, retry available

/** One utterance in the transcript. Speaker separation when channels allow. */
export interface CallTurn {
  /** "user" = our side (the recruiter/BD rep), "contact" = the far end. */
  role: "user" | "contact" | "unknown";
  text: string;
  /** Seconds from call start, when the transcription engine provides it. */
  atSec?: number;
}

/** Append-only per-call event trail (webhooks + client events), for debugging
 *  and the record's activity strip. Capped; oldest events drop first. */
export interface CallEvent {
  at: string;
  type: string;
  detail?: string;
}

/** Recording state carried on the call record. */
export interface CallRecording {
  /** Whether recording was on for this call (resolved from settings + manual). */
  enabled: boolean;
  /** Telnyx recording id (data.id on call.recording.saved). */
  recordingId?: string;
  /** Short-lived Telnyx download URL (refreshed via the recordings API). */
  url?: string;
  /** "single" | "dual" channel audio. Dual enables speaker separation. */
  channels?: string;
  durationSec?: number;
  /** ISO timestamp the recording URL expires (Telnyx links are short-lived). */
  urlExpiresAt?: string;
}

/** A single call: the system of record everything else hangs off. */
export interface CallRecord {
  id: string;
  workspaceId: string;
  motion: Motion;
  direction: CallDirection;
  status: CallStatus;
  /** E.164 of the far end. */
  externalNumber: string;
  /** Line used (our Telnyx number), denormalized for history rows. */
  lineId?: string;
  lineNumber?: string;
  /** Portal user on the call. */
  userId: string;
  userName?: string;
  /** Matched contact/company (nullable: "Unknown contact"). */
  prospectId?: string;
  contactName?: string;
  contactTitle?: string;
  companyId?: string;
  companyName?: string;
  /* -- timing -- */
  startedAt: string;
  answeredAt?: string;
  endedAt?: string;
  durationSec?: number;
  /* -- telnyx correlation -- */
  /** The PSTN-facing leg (recording/answer/bridge commands run here). */
  telnyxCallControlId?: string;
  telnyxSessionId?: string;
  telnyxLegId?: string;
  hangupCause?: string;
  /** Browser legs dialed for this call (inbound rings every assigned user;
   *  outbound has exactly one). First answer wins, the rest are canceled. */
  agentLegs?: Array<{ ccid: string; userId: string; status: "ringing" | "answered" | "done" }>;
  /* -- pipeline -- */
  recording: CallRecording;
  pipeline: PipelineStage;
  pipelineError?: string;
  /** Attempts of the current pipeline stage (for bounded retries). */
  pipelineAttempts?: number;
  transcript?: CallTurn[];
  /* -- notes: three layers, never merged destructively -- */
  /** Live notes the user typed during/after the call. Owned by the user. */
  userNotes?: string;
  userNotesUpdatedAt?: string;
  /** Latest AI analysis (regenerable; replaces only this layer). The bd motion
   *  produces BdCallAnalysis; the recruiting motion produces RecruitingCallAnalysis.
   *  Discriminate on `.kind` ("bd" | "recruiting"). */
  analysis?: BdCallAnalysis | RecruitingCallAnalysis;
  /** User corrections on top of the AI layer, keyed by analysis field name.
   *  Survive regeneration; the UI shows override > AI per field. */
  analysisOverrides?: Partial<BdAnalysisOverrides>;
  /* -- follow-ups -- */
  followUpIds: string[];
  events: CallEvent[];
  createdAt: string;
  updatedAt: string;
}

/* ======================= BD call intelligence ======================= */

export type CallSentiment =
  | "very_positive" | "positive" | "neutral" | "resistant" | "negative";

/**
 * Opportunity classification. Criteria (also encoded in the analysis prompt):
 *  hot          = live hiring need + engaged decision maker + concrete next step
 *  warm         = real need or strong interest, but timing/authority incomplete
 *  nurture      = no current need, door open; stay in touch on a cadence
 *  cold         = no need, no interest, nothing scheduled
 *  disqualified = hard blocker: DNC request, exclusive competitor lock-in,
 *                 wrong audience, or explicit never-interested
 */
export type OpportunityScore = "hot" | "warm" | "nurture" | "cold" | "disqualified";

/** One role the company is hiring for, as stated on the call. */
export interface HiringRole {
  title: string;
  openings?: number;
  department?: string;
  location?: string;
  /** "remote" | "hybrid" | "onsite" when stated. */
  workModel?: string;
  seniority?: string;
}

/** A person named on the call with buying influence. */
export interface CallPerson {
  name: string;
  title?: string;
  /** "decision_maker" | "influencer" | "referral" */
  role: string;
  note?: string;
}

/** One executable action item extracted from the call. */
export interface CallActionItem {
  id: string;
  text: string;
  /** ISO date when the item carries its own deadline. */
  dueDate?: string;
  done: boolean;
}

/**
 * The structured Business Development analysis of one call. Every field is
 * grounded in the transcript: the engine labels anything not discussed as
 * "Not discussed" / empty rather than inventing it.
 */
export interface BdCallAnalysis {
  /** Discriminator for the analysis union on CallRecord. */
  kind?: "bd";
  /** Short factual recap of the conversation. */
  summary: string;
  /** Why the conversation happened. */
  callReason: string;
  /** The recruiting/hiring/talent problem discussed, if any. */
  businessNeed: string;
  /** What the company does for recruiting today, in prose. */
  currentSituation: string;
  /** Normalized tags for the current approach, e.g. "internal_recruiting",
   *  "contingent_search", "retained_search", "staffing_agency", "none". */
  currentApproach: string[];
  hiringActive: boolean;
  roles: HiringRole[];
  hiringUrgency: string;
  hiringTimeline: string;
  /** Pain points actually expressed; never fabricated. */
  painPoints: string[];
  /** Recruiting firms / staffing agencies / internal teams named. */
  vendors: string[];
  people: CallPerson[];
  objections: string[];
  buyingSignals: string[];
  nextSteps: string[];
  /** ISO date (or descriptive text when only a timeframe was given). */
  followUpDate?: string;
  actionItems: CallActionItem[];
  sentiment: CallSentiment;
  opportunity: OpportunityScore;
  /** Why the opportunity classification landed where it did. */
  opportunityRationale: string;
  /* -- provenance -- */
  generatedAt: string;
  model: string;
  /** Increments on every regeneration. */
  version: number;
}

/** Narrow a CallRecord's analysis to the BD shape (legacy records lack kind,
 *  and predate the union: they are BD). RecruitingCallAnalysis is below. */
export function asBdAnalysis(
  a?: BdCallAnalysis | RecruitingCallAnalysis,
): BdCallAnalysis | undefined {
  if (!a) return undefined;
  return a.kind === "recruiting" ? undefined : (a as BdCallAnalysis);
}

/** The analysis fields a user may override. Overrides are sparse: only fields
 *  the user actually edited appear, and each remembers who/when. */
export interface BdAnalysisOverrides {
  summary: FieldEdit<string>;
  callReason: FieldEdit<string>;
  businessNeed: FieldEdit<string>;
  currentSituation: FieldEdit<string>;
  hiringUrgency: FieldEdit<string>;
  hiringTimeline: FieldEdit<string>;
  painPoints: FieldEdit<string[]>;
  vendors: FieldEdit<string[]>;
  objections: FieldEdit<string[]>;
  buyingSignals: FieldEdit<string[]>;
  nextSteps: FieldEdit<string[]>;
  followUpDate: FieldEdit<string>;
  sentiment: FieldEdit<CallSentiment>;
  opportunity: FieldEdit<OpportunityScore>;
}

export interface FieldEdit<T> {
  value: T;
  editedBy: string;
  editedAt: string;
}

/* ==================== Recruiting call intelligence ==================== */

/** How the candidate reads as a fit for the roles discussed. */
export type CandidateFit = "strong" | "possible" | "weak" | "not_a_fit" | "unclear";

/** One compensation figure as stated on the call (never inferred). */
export interface CompDetail {
  /** "base" | "ote" | "total" | "hourly" | "equity" | "bonus" | "other" */
  kind: string;
  /** Verbatim-faithful amount as said, e.g. "$145k base", "$70/hr", "unclear". */
  amount: string;
}

/**
 * The structured Recruiting analysis of one candidate screening call. Same
 * grounding contract as the BD engine: fields the conversation did not cover
 * come back empty, never invented. The standout field is `submittal`: a
 * polished, ready-to-send candidate writeup for the hiring manager.
 */
export interface RecruitingCallAnalysis {
  kind: "recruiting";
  /** 2-4 factual sentences recapping the screen. */
  summary: string;
  /** Candidate's current title + employer as stated. */
  currentRole: string;
  currentEmployer: string;
  /** Total years of relevant experience, as stated or clearly supported. */
  yearsExperience: string;
  /** Current compensation figures the candidate stated. */
  currentComp: CompDetail[];
  /** Compensation expectations / desired range the candidate stated. */
  compExpectations: CompDetail[];
  /** Notice period / earliest start, e.g. "2 weeks", "immediately". */
  availability: string;
  /** Where the candidate is based. */
  location: string;
  /** "remote" | "hybrid" | "onsite" | "flexible" | "" work preference. */
  workModelPreference: string;
  /** Open to relocation: their stated answer, "" if not discussed. */
  relocation: string;
  /** Roles / titles the candidate is targeting or open to. */
  rolesOfInterest: string[];
  /** Why the candidate is exploring: motivations for a move. */
  motivations: string[];
  /** Non-negotiables the candidate named (comp floor, remote-only, etc.). */
  mustHaves: string[];
  /** Deal-breakers the candidate named. */
  dealBreakers: string[];
  /** Demonstrated strengths / standout skills, grounded in what was said. */
  strengths: string[];
  /** Concerns or risks a recruiter should flag (gaps, job hopping, mismatch),
   *  only where the conversation supports them. Never speculative character judgments. */
  concerns: string[];
  /** Notable skills / tech / domains the candidate claimed. */
  skills: string[];
  /** Overall fit read for the roles discussed. */
  fit: CandidateFit;
  /** 1-2 sentences citing the evidence behind the fit read. */
  fitRationale: string;
  /** How engaged / interested the candidate was. */
  sentiment: CallSentiment;
  /** What happens next (imperatives). */
  nextSteps: string[];
  /** ISO date or descriptive timeframe if a follow-up was agreed. */
  followUpDate?: string;
  actionItems: CallActionItem[];
  /**
   * THE hiring-manager submittal: a polished multi-paragraph candidate
   * presentation the recruiter can send as-is. Professional, specific,
   * grounded only in the call. No em-dashes.
   */
  submittal: string;
  /** A tight one-line pitch for the top of a submittal or a Slack message. */
  headline: string;
  /* -- provenance -- */
  generatedAt: string;
  model: string;
  version: number;
}

/* ============================ follow-ups ============================ */

export type FollowUpStatus = "open" | "done" | "dismissed";

/** A follow-up task created from a call (AI-suggested or manual). */
export interface CallFollowUp {
  id: string;
  workspaceId: string;
  motion: Motion;
  callId: string;
  title: string;
  /** ISO date the follow-up is due, when known. */
  dueDate?: string;
  status: FollowUpStatus;
  /** "ai" when created from an AI action item, "manual" otherwise. */
  source: "ai" | "manual";
  /** The analysis action-item id this was created from (dedupe guard). */
  actionItemId?: string;
  prospectId?: string;
  contactName?: string;
  companyName?: string;
  createdBy: string;
  createdAt: string;
  completedAt?: string;
}

/* ============================= settings ============================= */

export type RecordingMode = "all" | "outbound" | "inbound" | "off";

/** Per-workspace, per-motion phone settings. */
export interface PhoneSettings {
  /** Automatic recording policy. */
  recordingMode: RecordingMode;
  /** Let users start/stop recording manually during a call. */
  manualRecordingToggle: boolean;
  /** Run the transcript -> LLM notes pipeline for recorded calls. */
  transcriptionEnabled: boolean;
  /**
   * Operator attestation that call recording is used lawfully (consent
   * obtained per the jurisdictions they call). Recording stays off until
   * attested, mirroring the Voice Drops consent gate.
   */
  recordingConsentAttested: boolean;
  recordingConsentAttestedBy?: string;
  recordingConsentAttestedAt?: string;
}

export const DEFAULT_PHONE_SETTINGS: PhoneSettings = {
  recordingMode: "all",
  manualRecordingToggle: true,
  transcriptionEnabled: true,
  recordingConsentAttested: false,
};

/** Resolve whether a call should record, from settings + direction. */
export function shouldRecord(settings: PhoneSettings, direction: CallDirection): boolean {
  if (!settings.recordingConsentAttested) return false;
  switch (settings.recordingMode) {
    case "all": return true;
    case "outbound": return direction === "outbound";
    case "inbound": return direction === "inbound";
    default: return false;
  }
}

/* ============================ list filters ============================ */

/** Call-history query, matching the History tab's filter bar. */
export interface CallQuery {
  q?: string;
  direction?: CallDirection | "missed";
  status?: CallStatus;
  userId?: string;
  lineId?: string;
  opportunity?: OpportunityScore;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}
