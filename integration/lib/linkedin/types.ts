/**
 * RecruitersOS · LinkedIn Engine
 * Domain types shared across the integration.
 *
 * These types are intentionally framework-agnostic so they can be mapped onto
 * the RecruitersOS core models (Campaign, Prospect, Sequence) without coupling
 * the LinkedIn execution layer to any specific ORM.
 */

/** A connected LinkedIn sending account (one seat). */
export interface LinkedInAccount {
  id: string;                 // RecruitersOS account id
  providerAccountId: string;  // id in the underlying provider (e.g. Unipile)
  ownerUserId: string;        // RecruitersOS user who owns the seat
  displayName: string;
  status: "ok" | "warming" | "restricted" | "disconnected";
  /** Premium / Sales Navigator unlocks InMail + open-profile messaging. */
  premium: boolean;
  salesNavigator: boolean;
  /** Soft daily ceilings the rate limiter enforces (account-safe defaults). */
  limits: AccountLimits;
  /** IANA timezone used for working-hours pacing, e.g. "Europe/Berlin". */
  timezone: string;
}

export interface AccountLimits {
  invitesPerDay: number;      // connection requests / 24h
  messagesPerDay: number;     // 1:1 messages / 24h
  inmailsPerDay: number;      // InMail / 24h
  profileViewsPerDay: number; // warmup visits / 24h
  /** Only act between these local hours (24h clock). */
  workingHours: { startHour: number; endHour: number; days: number[] }; // days 1=Mon..7=Sun
}

/** A person we want to reach on LinkedIn. */
export interface Prospect {
  id: string;
  campaignId: string;
  fullName: string;
  firstName: string;
  /** LinkedIn member identifier or public profile id resolved by the provider. */
  providerProfileId?: string;
  publicProfileUrl?: string;
  headline?: string;
  company?: string;
  location?: string;
  /** Free-form enrichment + signal context used to personalize copy. */
  context?: ProspectContext;
  connectionDegree?: 1 | 2 | 3;
}

export interface ProspectContext {
  /** The triggering signal, e.g. "web platform reorg" or "Series B raise". */
  signal?: string;
  /** Notable, specific work to recognize in touch #1 (rapport-first). */
  recognition?: string;
  /** Role being pitched, with concrete details for the eventual ask. */
  role?: { title: string; comp?: string; remote?: boolean; stack?: string[] };
  /** Anything else the personalizer should know (recent posts, mutuals…). */
  notes?: string[];
}

/** Channels the LinkedIn Engine can execute. */
export type LinkedInActionType =
  | "profile_view"      // warmup
  | "endorse"           // warmup
  | "connect"           // connection request (+ optional note)
  | "message"           // 1:1 message to a connection
  | "inmail"            // InMail to a non-connection (premium)
  | "voice_note"        // audio message
  | "withdraw_invite";  // pull back a stale pending request

/** One step in a LinkedIn-aware sequence. */
export interface SequenceStep {
  id: string;
  order: number;
  action: LinkedInActionType;
  /** Wait this long after the *previous step completed* before running. */
  delayHours: number;
  /**
   * Rapport-first rung this step plays. Drives the personalization prompt and
   * keeps the "build rapport before pitching" structure enforceable.
   */
  rung: "recognize" | "relate" | "invite" | "pitch" | "release" | "warmup";
  /** Only run once the invite is accepted (accept-triggered follow-up). */
  requiresConnection?: boolean;
  /** Optional A/B variants; the engine picks by weight. */
  variants?: SequenceVariant[];
}

export interface SequenceVariant {
  id: string;
  label: string;          // e.g. "Direct" | "Curiosity"
  weight: number;         // relative traffic weight
  /** Optional hand-written template; if absent, AI generates from the rung. */
  template?: string;
}

export interface Sequence {
  id: string;
  campaignId: string;
  name: string;
  steps: SequenceStep[];
}

/** A prospect's live position within a sequence. */
export interface Enrollment {
  id: string;
  prospectId: string;
  sequenceId: string;
  accountId: string;
  status: "active" | "paused_replied" | "completed" | "stopped" | "failed";
  currentStepOrder: number;
  /** When the next due step may run (ISO). */
  nextRunAt: string | null;
  connectedAt: string | null;
  lastEventAt: string | null;
}

/** Inbound provider events (normalized). */
export type LinkedInWebhookEvent =
  | { type: "invite_accepted"; accountId: string; providerProfileId: string; at: string }
  | { type: "message_received"; accountId: string; providerProfileId: string; text: string; at: string; providerMessageId: string }
  | { type: "message_sent"; accountId: string; providerMessageId: string; at: string }
  | { type: "account_status"; accountId: string; status: LinkedInAccount["status"]; at: string };

/** AI classification of an inbound reply. */
export type ReplyIntent =
  | "positive"
  | "soft_yes"
  | "timing_objection"
  | "fit_objection"
  | "referral"
  | "not_interested"
  | "stop";

export interface ClassifiedReply {
  intent: ReplyIntent;
  confidence: number;       // 0..1
  /** True when a human should take over now. */
  escalate: boolean;
  /** Suggested next action for the engine / recruiter. */
  suggestion: string;
}

/** Result of executing a single action against the provider. */
export interface ActionResult {
  ok: boolean;
  action: LinkedInActionType;
  providerMessageId?: string;
  error?: string;
  /** Set when the rate limiter deferred the action. */
  deferredUntil?: string;
}
