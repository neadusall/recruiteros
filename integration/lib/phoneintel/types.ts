/**
 * RecruitersOS · Phone Intelligence · Data model
 *
 * The Corporate Telephone Routing Graph (spec §2-4, §29-31). Every entity is
 * workspace-scoped and carries id/createdAt/updatedAt, per the house store
 * convention. Routes and profiles are the durable asset: learn a company's
 * switchboard once, reuse it for every future prospect there.
 */

import type { DirectorySpec } from "./keypad";

/* ------------------------------- companies ------------------------------- */

export interface CompanyPhoneProfile {
  id: string;
  workspaceId: string;
  companyKey: string; // normalized company name or domain (graph key; shared across recruiters)
  companyName: string;
  domain?: string;
  mainPhone: string; // E.164

  phoneSystemDetected: boolean;
  systemType?: "ivr" | "receptionist" | "direct" | "voicemail" | "unknown";
  directoryAvailable?: boolean;
  /** How the directory searches (parsed once, cached). */
  directorySpec?: DirectorySpec;
  operatorAvailable?: boolean;

  knownRoute: boolean;
  routeId?: string;
  routeConfidence: number; // 0..1
  lastVerifiedAt?: string;

  createdAt: string;
  updatedAt: string;
}

/* ------------------------------- routes ---------------------------------- */

/** One deterministic step in a learned route. */
export interface RouteStep {
  /** The prompt fingerprint this step responds to (change-detection anchor). */
  waitFor: string;
  action:
    | { type: "dtmf"; value: string }
    | { type: "dynamic_name_search" } // fills from the target contact at call time
    | { type: "speak_name" }
    | { type: "extension" }
    | { type: "wait"; ms: number };
  /** Human-readable meaning for the debugger. */
  meaning?: string;
}

export interface IvrRoute {
  id: string;
  workspaceId: string;
  companyKey: string;
  mainPhone: string;
  version: number; // never destroyed; a changed IVR mints a new version (spec §59)
  steps: RouteStep[];
  confidence: number; // 0..1 (spec §11)
  timesUsed: number;
  timesSucceeded: number;
  active: boolean; // false = superseded by a newer version
  createdAt: string;
  updatedAt: string;
}

/** A recognized IVR menu node, fingerprinted so we don't re-interpret it. */
export interface IvrNode {
  id: string;
  workspaceId: string;
  companyKey: string;
  promptHash: string;
  promptTranscript: string;
  options: Array<{ digit: string; meaning: string; isDirectory: boolean; isOperator: boolean }>;
  seenCount: number;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------- calls ----------------------------------- */

export type CallState =
  | "queued" | "dialing" | "ringing" | "answered" | "classifying"
  | "navigating" | "searching_directory" | "waiting_transfer"
  | "verifying" | "exiting" | "completed" | "failed";

export type AnswerClass =
  | "ivr" | "voicemail_generic" | "voicemail_named"
  | "human_receptionist" | "human_generic" | "target_human"
  | "disconnected" | "busy" | "no_answer" | "unknown";

/** Final disposition (spec §24). */
export type Disposition =
  | "TARGET_VERIFIED_VOICEMAIL" | "TARGET_PROBABLE_HUMAN"
  | "DIRECTORY_MATCH" | "DIRECTORY_NO_MATCH" | "RECEPTIONIST"
  | "GENERIC_VOICEMAIL" | "GENERIC_HUMAN"
  | "IVR_ROUTE_DISCOVERED" | "IVR_ROUTE_FAILED"
  | "NO_ANSWER" | "BUSY" | "DISCONNECTED" | "INVALID_NUMBER"
  | "FAILED_TRANSFER" | "UNKNOWN";

/** Success sub-types recorded on the call (spec §23) — not one generic flag. */
export type SuccessType =
  | "COMPANY_PHONE_VERIFIED" | "IVR_DETECTED" | "DIRECTORY_FOUND"
  | "DIRECTORY_SEARCH_SUCCESS" | "EXTENSION_DISCOVERED" | "EXTENSION_VERIFIED"
  | "TARGET_VOICEMAIL_VERIFIED" | "TARGET_HUMAN_PROBABLE" | "TARGET_HUMAN_VERIFIED"
  | "LIVE_RECEPTIONIST" | "GENERIC_HUMAN" | "TRANSFER_SUCCESS" | "ROUTE_VERIFIED";

/** One timeline entry (spec §26) — every decision is auditable (spec §52). */
export interface IntelCallEvent {
  at: string;
  /** offset seconds from call start, for the timeline view. */
  t?: number;
  type: string; // e.g. "IVR_PROMPT", "SEND_DTMF", "CLASSIFY", "VERIFY"
  detail?: string;
  /** For decisions: why + confidence + source (rule/classifier/llm/known_route). */
  reason?: string;
  confidence?: number;
  source?: "known_route" | "prompt_match" | "rule" | "classifier" | "llm" | "human";
}

export interface IntelCall {
  id: string;
  workspaceId: string;
  mode: "discovery" | "known_route";
  state: CallState;

  /** Target contact snapshot (denormalized so history is self-contained). */
  companyKey: string;
  companyName: string;
  targetContactId?: string;
  targetFirst?: string;
  targetLast?: string;
  targetFull: string;
  targetTitle?: string;
  toNumber: string; // E.164 dialed

  telnyxCallControlId?: string;
  fromNumber?: string;
  lineId?: string;

  answerClass?: AnswerClass;
  disposition?: Disposition;
  successTypes: SuccessType[];

  /** Discovered facts. */
  extension?: string;
  detectedName?: string;
  nameMatchScore?: number;

  /** Navigation bookkeeping / guardrails. */
  stepIndex: number;
  ivrSteps: number;
  directorySearches: number;
  unknownPrompts: number;
  promptHistory: string[]; // fingerprints, for loop detection

  events: IntelCallEvent[];
  startedAt: string;
  answeredAt?: string;
  endedAt?: string;
  durationSec?: number;

  /** Evidence pointers (spec §25). */
  recordingId?: string;
  recordingUrl?: string;

  createdAt: string;
  updatedAt: string;
}

/* --------------------------- verifications ------------------------------- */

export interface ContactVerification {
  id: string;
  workspaceId: string;
  callId: string;
  companyKey: string;
  contactId?: string;
  targetFull: string;
  verificationType:
    | "voicemail_name_match" | "human_probable" | "extension_only" | "receptionist_number_valid";
  detectedName?: string;
  confidence: number;
  success: boolean;
  evidence?: {
    audioSegment?: string; // "00:41-00:48"
    transcript?: string;
    recordingUrl?: string;
  };
  createdAt: string;
}

/* --------------------------- contact outreach ---------------------------- */

/**
 * Per-contact outreach ledger (user rule): count live-answers vs voicemails,
 * rotate OUR calling number away from any number that reached a live person, and
 * stick to the number that successfully left a voicemail for follow-ups.
 */
export interface ContactOutreachState {
  id: string;
  workspaceId: string;
  /** Stable key: contactId when known, else `${companyKey}|${nameLower}`. */
  contactKey: string;
  companyKey: string;
  contactId?: string;
  targetFull: string;

  liveAnswerCount: number;
  voicemailCount: number;

  /** Our from-numbers that reached a LIVE person here — never dial them again. */
  burnedNumbers: string[];
  /** The from-number that successfully left a voicemail — preferred for follow-ups. */
  preferredNumber?: string;

  lastOutcome?: "live" | "voicemail" | "other";
  lastCalledAt?: string;
  updatedAt: string;
}

/* ----------------------------- guardrails -------------------------------- */

export const GUARDRAILS = {
  MAX_DURATION_SEC: 240,
  MAX_IVR_STEPS: 12,
  MAX_DIRECTORY_SEARCHES: 2,
  MAX_UNKNOWN_PROMPTS: 3,
  MAX_SAME_NODE: 3, // loop detection (spec §41)
} as const;

/** Route confidence deltas (spec §11). */
export const CONFIDENCE = {
  SUCCESS: +0.05,
  MENU_CHANGED: -0.3,
  INVALID_SELECTION: -0.2,
  REDISCOVER_BELOW: 0.5,
  VERIFIED_AT: 0.9,
} as const;
