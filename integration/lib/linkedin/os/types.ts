/**
 * RecruitersOS · LinkedIn OS
 * Domain types for the SHARED LinkedIn engine: one utilization + policy +
 * reservation + ledger layer that every LinkedIn action in RecruitersOS flows
 * through, whether it came from a LinkedIn-only campaign, a multichannel
 * workflow, a hire signal, a manual send, or an AI-created workflow.
 *
 * The standalone LinkedIn tool UI and the multichannel workflow builder are
 * two entrances into the SAME engine defined here. Nothing outside lib/linkedin
 * may talk to the provider (Unipile) directly.
 */

/** Which side of the house is consuming capacity. Maps 1:1 onto core Motion. */
export type BusinessUnit = "recruiting" | "bd";

/** Every LinkedIn action the engine can execute or account for. */
export type LiActionType =
  | "connect"          // connection request (no note)
  | "connect_note"     // connection request with a personalized note
  | "message"          // 1:1 message to a connection
  | "voice_note"       // audio message
  | "inmail"           // InMail to a non-connection
  | "attachment"       // message carrying a file attachment
  | "profile_view"     // warmup visit
  | "endorse"          // endorse top skills (warmup)
  | "like_post"        // post interaction
  | "comment_post"     // post interaction
  | "withdraw_invite"; // housekeeping, not outreach

/**
 * Policy buckets. Each bucket has its own daily target + hard ceiling in the
 * account policy; every action type counts toward exactly one bucket.
 */
export type LiCapCategory =
  | "connections"
  | "messages"
  | "voice_notes"
  | "inmails"
  | "profile_views"
  | "interactions";

export function capCategoryOf(action: LiActionType): LiCapCategory | null {
  switch (action) {
    case "connect":
    case "connect_note": return "connections";
    case "message":
    case "attachment": return "messages";
    case "voice_note": return "voice_notes";
    case "inmail": return "inmails";
    case "profile_view": return "profile_views";
    case "endorse":
    case "like_post":
    case "comment_post": return "interactions";
    case "withdraw_invite": return null; // housekeeping: never capped
  }
}

/** Ledger lifecycle. Reserved/scheduled/queued/processing all HOLD capacity. */
export type LiActionStatus =
  | "requested"         // accepted by the engine, pre-checks running
  | "capacity_pending"  // waiting for utilization headroom (visible reason)
  | "reserved"          // capacity reserved, not yet time-scheduled
  | "scheduled"         // has an execution time
  | "queued"            // picked up by the executor for this cycle
  | "processing"        // provider call in flight
  | "submitted"         // provider accepted it (async confirmation may follow)
  | "success"
  | "failed"
  | "retry_pending"     // failed, will retry with backoff
  | "cancelled"         // reply/stop/conflict cancelled it; capacity released
  | "suppressed"        // blocked by DNC / person state; never held capacity
  | "paused";           // held by pressure/health/kill switch review

/** Statuses that currently HOLD reserved capacity against the daily numbers. */
export const HOLDING_STATUSES: LiActionStatus[] = [
  "reserved", "scheduled", "queued", "processing", "submitted",
];
/** Statuses that count as USED capacity for the day. */
export const USED_STATUSES: LiActionStatus[] = ["success"];
/** Statuses that are waiting in line and consume nothing yet. */
export const WAITING_STATUSES: LiActionStatus[] = ["requested", "capacity_pending", "retry_pending"];

export type LiSourceType =
  | "linkedin_campaign"
  | "multichannel_workflow"
  | "hire_signal"
  | "manual"
  | "ai_workflow";

export type LiPriority = "critical" | "high" | "normal" | "low";

export const PRIORITY_RANK: Record<LiPriority, number> = {
  critical: 0, high: 1, normal: 2, low: 3,
};

/** One row in the global LinkedIn action ledger. Every action gets one. */
export interface LiActionRecord {
  id: string;
  workspaceId: string;
  accountId: string;
  personIdentityId: string;
  campaignId?: string;
  workflowId?: string;
  workflowEnrollmentId?: string;
  sequenceStepId?: string;
  businessUnit: BusinessUnit;
  sourceType: LiSourceType;
  actionType: LiActionType;
  priority: LiPriority;
  /** Unique execution key so a retried worker can never double-send. */
  idempotencyKey: string;
  /** Payload the executor needs (message text, note, audio asset, subject). */
  payload: {
    text?: string;
    subject?: string;
    note?: string;
    voiceAssetId?: string;
    audioUrl?: string;
    attachmentUrl?: string;
    postUrl?: string;
    /** Resolved provider profile id, filled at execution when known. */
    providerProfileId?: string;
    linkedinUrl?: string;
  };
  status: LiActionStatus;
  /** Why the action is waiting/paused/suppressed, shown verbatim in the UI. */
  statusReason?: string;
  requestedAt: string;
  reservedAt?: string;
  scheduledAt?: string;
  submittedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  providerReference?: string;
  failureReason?: string;
  retryCount: number;
  /** The policy day (YYYY-MM-DD in the account timezone) capacity was booked on. */
  capacityDay?: string;
  /** Audit trail: who/what approved the source (hire signal approvals etc.). */
  approvedBy?: string;
  signalId?: string;
}

/* ------------------------------------------------------------------ */
/* Policies                                                            */
/* ------------------------------------------------------------------ */

export type PolicyMode = "conservative" | "balanced" | "aggressive" | "custom";

export interface CategoryPolicy {
  dailyTarget: number;
  hardCeiling: number;
  weeklyTarget: number;
}

export type PressureState = "low" | "medium" | "elevated" | "high";
export type PressureAction = "none" | "increase_spacing" | "defer_low_priority" | "pause_review";

export interface PressureConfig {
  /** Rolling window, days. */
  windowDays: number;
  /** Weighted touches allowed inside the window before pressure elevates. */
  maxTouches: number;
  /** Channel weights: how much each outbound touch presses on a person. */
  weights: {
    email: number;
    connection: number;
    linkedin_message: number;
    voice_note: number;
    inmail: number;
    voicemail: number;
    sms: number;
  };
  /** Weighted score at/above which pressure reads ELEVATED. */
  elevatedThreshold: number;
  /** Weighted score at/above which pressure reads HIGH. */
  highThreshold: number;
  elevatedAction: PressureAction;
  highAction: PressureAction;
}

/**
 * The per-account RecruitersOS utilization policy. These are OUR operating
 * targets, never a claim about what LinkedIn allows. The UI copy must always
 * present them as "RecruitersOS Daily Target" / "RecruitersOS Hard Ceiling".
 */
export interface AccountPolicy {
  workspaceId: string;
  accountId: string;
  mode: PolicyMode;
  categories: Record<LiCapCategory, CategoryPolicy>;
  pacing: {
    minDelayMinutes: number;
    maxDelayMinutes: number;
    randomizedTiming: boolean;
    burstProtection: boolean;
    autoCooldown: boolean;
    capacityReallocation: boolean;
  };
  workingHours: { startHour: number; endHour: number; days: number[] };
  timezone: string;
  pressure: PressureConfig;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Canonical person identity                                           */
/* ------------------------------------------------------------------ */

/**
 * One human. Candidates, prospects, contacts, LinkedIn profiles, emails and
 * phones all link back here so two campaigns can never treat the same person
 * as two different people.
 */
export interface PersonIdentity {
  id: string;
  workspaceId: string;
  fullName?: string;
  company?: string;
  title?: string;
  /** Linked RecruitersOS records. */
  prospectIds: string[];
  dataRecordIds: string[];
  /** Normalized handles (lowercased emails, canonical /in/ urls, E.164 phones). */
  emails: string[];
  phones: string[];
  linkedinUrls: string[];
  /** Provider ids differ per LinkedIn product; never assume interchangeable. */
  providerIds: {
    classic?: string;
    salesNavigator?: string;
    recruiter?: string;
  };
  publicIdentifier?: string;
  connectionDegree?: 1 | 2 | 3;
  connectedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Person-level cross-channel outreach state: the single source of truth. */
export interface PersonOutreachState {
  personIdentityId: string;
  workspaceId: string;
  activeWorkflowId?: string;
  activeEnrollmentId?: string;
  activeSource?: LiSourceType;
  activeBusinessUnit?: BusinessUnit;
  lastOutboundAt?: string;
  lastOutboundChannel?: string;
  lastInboundAt?: string;
  lastInboundChannel?: string;
  replyDetected: boolean;
  replyChannel?: string;
  automationPaused: boolean;
  pausedReason?: string;
  pausedAt?: string;
  contactPressureScore: number;
  pressureState: PressureState;
  engagementStatus?: string;
  ownerId?: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Account state / health                                              */
/* ------------------------------------------------------------------ */

export type AccountHealthState =
  | "healthy" | "watch" | "elevated" | "cooldown" | "paused" | "disconnected";

export interface RiskSignal {
  kind: string;
  detail: string;
  at: string;
}

export interface LiAccountState {
  workspaceId: string;
  accountId: string;
  displayName: string;
  providerAccountId?: string;
  /** Which LinkedIn products were detected on this seat. */
  products: { classic: boolean; salesNavigator: boolean; recruiter: boolean };
  connected: boolean;
  health: AccountHealthState;
  healthReason?: string;
  riskSignals: RiskSignal[];
  /** The one-switch global pause for everything on this account. */
  killSwitch: boolean;
  cooldownUntil?: string;
  /** Rolling failure window used by the risk engine. */
  recentResults: Array<{ ok: boolean; at: string; kind?: string }>;
  ownerUserId?: string;
  timezone?: string;
  createdAt: string;
  updatedAt: string;
}

/** Capacity multiplier per health state (spec: reduce before stopping). */
export const HEALTH_CAPACITY_FACTOR: Record<AccountHealthState, number> = {
  healthy: 1, watch: 0.85, elevated: 0.6, cooldown: 0, paused: 0, disconnected: 0,
};

/* ------------------------------------------------------------------ */
/* Campaigns + sequences                                                */
/* ------------------------------------------------------------------ */

export type LiStepType =
  | "view_profile"
  | "connect"
  | "connect_note"
  | "wait"
  | "wait_random"
  | "wait_until_accepted"
  | "message"
  | "voice_note"
  | "inmail"
  | "attachment"
  | "like_post"
  | "comment_post"
  | "ai_decision"
  | "if_else"
  | "wait_for_reply"
  | "manual_task"
  | "update_person"
  | "add_tag"
  | "move_stage"
  | "create_todo"
  | "notify_user"
  | "stop"
  | "transfer_workflow";

export interface LiStep {
  id: string;
  type: LiStepType;
  label?: string;
  /** wait / wait_random: hours. wait_random uses [hours, maxHours]. */
  hours?: number;
  maxHours?: number;
  /** message / note / inmail template with {variables}. */
  text?: string;
  subject?: string;
  voiceAssetId?: string;
  /** if_else / wait_for_reply: condition key ("replied_anywhere" default). */
  condition?: string;
  /** Branch targets by step index for if_else (yes/no). */
  yesIndex?: number;
  noIndex?: number;
  /** wait_until_accepted: give up after N days and continue at noIndex/stop. */
  timeoutDays?: number;
  tag?: string;
  stage?: string;
  note?: string;
}

export type LiCampaignStatus =
  | "draft" | "running" | "paused" | "waiting_capacity" | "completed" | "archived";

export interface LiCampaign {
  id: string;
  workspaceId: string;
  name: string;
  type: BusinessUnit;
  accountId: string;
  /** Associated entity (job, search, client, company list, signal batch...). */
  entity?: { kind: string; name: string; refId?: string };
  priority: LiPriority;
  /** Relative allocation weight for fair capacity sharing. */
  weight: number;
  minAllocation?: number;
  maxAllocation?: number;
  objective?: string;
  ownerId?: string;
  ownerName?: string;
  status: LiCampaignStatus;
  steps: LiStep[];
  /** Voice note approval mode for this campaign. */
  voiceApproval: "automated" | "review_first_10" | "manual";
  voiceApprovedCount: number;
  schedule?: { startDate?: string; endDate?: string };
  /** Enrollment slow-drip cap: new people activated per business day. */
  dailyEnrollTarget?: number;
  createdAt: string;
  updatedAt: string;
}

export type LiEnrollmentStatus =
  | "active" | "waiting_capacity" | "waiting_accept" | "paused_replied"
  | "paused_pressure" | "paused_review" | "completed" | "stopped" | "failed";

export interface LiEnrollment {
  id: string;
  workspaceId: string;
  campaignId: string;
  personIdentityId: string;
  prospectId?: string;
  accountId: string;
  businessUnit: BusinessUnit;
  status: LiEnrollmentStatus;
  stepIndex: number;
  /** Iteration guard for idempotency keys when a step re-runs after edit. */
  iteration: number;
  nextRunAt: string | null;
  /** The ledger action currently in flight for this enrollment, if any. */
  pendingActionId?: string;
  /** A voice approval item this enrollment is waiting on, if any. */
  pendingApprovalId?: string;
  connectedAt?: string;
  waitingSince?: string;
  lastEventAt?: string;
  enrolledAt: string;
  completedAt?: string;
  stopReason?: string;
}

/* ------------------------------------------------------------------ */
/* Inbox                                                                */
/* ------------------------------------------------------------------ */

export interface LiMessage {
  id: string;
  providerMessageId?: string;
  fromSelf: boolean;
  kind: "text" | "voice" | "inmail" | "attachment" | "system";
  text?: string;
  audioUrl?: string;
  at: string;
}

export interface LiConversation {
  id: string;
  workspaceId: string;
  accountId: string;
  personIdentityId: string;
  providerChatId?: string;
  providerProfileId?: string;
  displayName: string;
  headline?: string;
  company?: string;
  businessUnit?: BusinessUnit;
  campaignId?: string;
  messages: LiMessage[];
  unread: boolean;
  needsAttention: boolean;
  /** AI intent, editable by the user. */
  intent?: string;
  intentConfidence?: number;
  intentEditedBy?: string;
  lastMessageAt: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Voice notes                                                          */
/* ------------------------------------------------------------------ */

export type VoiceAssetMode = "static" | "ai";

export interface VoiceAsset {
  id: string;
  workspaceId: string;
  name: string;
  mode: VoiceAssetMode;
  /** static: uploaded/recorded audio file key served by the audio route. */
  audioFile?: string;
  durationSec?: number;
  /** ai: script template with {first_name} style variables. */
  script?: string;
  provider?: string;   // elevenlabs | cartesia | hume | manual
  voiceId?: string;
  tags: string[];
  category?: string;
  isTemplate: boolean;
  /** Performance counters, updated by the executor. */
  stats: { sent: number; replies: number };
  createdAt: string;
  updatedAt: string;
}

/** A generated per-person voice note waiting for approval (review modes). */
export interface VoiceApprovalItem {
  id: string;
  workspaceId: string;
  campaignId: string;
  actionId: string;
  personIdentityId: string;
  personName: string;
  script: string;
  audioFile?: string;
  status: "pending" | "approved" | "skipped";
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Slow-drip activation                                                 */
/* ------------------------------------------------------------------ */

export type ActivationStatus = "waiting" | "activated" | "skipped" | "cancelled";

export interface ActivationEntry {
  id: string;
  workspaceId: string;
  batchId: string;
  personIdentityId: string;
  prospectId?: string;
  displayName: string;
  signalLabel?: string;
  /** Where the contact goes when activated. */
  target: { kind: "linkedin_campaign" | "core_campaign"; id: string; name?: string };
  businessUnit: BusinessUnit;
  priority: LiPriority;
  ownerId?: string;
  status: ActivationStatus;
  /** Why the entry is still waiting, shown verbatim in the queue UI. */
  waitReason?: string;
  expected?: string;
  approvedBy?: string;
  approvedAt: string;
  activatedAt?: string;
}

export interface ActivationBatch {
  id: string;
  workspaceId: string;
  name: string;
  signalLabel?: string;
  signalId?: string;
  companyName?: string;
  mode: "dynamic_slow_drip" | "fixed_daily" | "immediate";
  dailyTarget: number;
  businessUnit: BusinessUnit;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Events                                                               */
/* ------------------------------------------------------------------ */

export interface LiRawEvent {
  id: string;
  workspaceId?: string;
  source: string;
  receivedAt: string;
  payload: unknown;
}

export type LiDomainEventType =
  | "linkedin.message.received"
  | "linkedin.message.sent"
  | "linkedin.connection.accepted"
  | "linkedin.account.connected"
  | "linkedin.account.disconnected"
  | "linkedin.action.failed"
  | "linkedin.chat.created";

export interface LiDomainEvent {
  id: string;
  type: LiDomainEventType;
  workspaceId: string;
  accountId?: string;
  personIdentityId?: string;
  providerProfileId?: string;
  providerMessageId?: string;
  text?: string;
  at: string;
}

/* ------------------------------------------------------------------ */
/* Utilization reporting shapes (shared with the UI)                    */
/* ------------------------------------------------------------------ */

export interface CategoryUtilization {
  category: LiCapCategory;
  used: number;
  reserved: number;
  waiting: number;
  dailyTarget: number;
  hardCeiling: number;
  /** Health-adjusted effective target for today. */
  effectiveTarget: number;
}

export interface AllocationSlice {
  key: string;             // campaignId or workflowId
  name: string;
  businessUnit: BusinessUnit;
  priority: LiPriority;
  weight: number;
  demand: number;
  allocated: number;
  usedToday: number;
}
