/**
 * RecruitersOS · Outbound Performance · shared types
 *
 * The normalized vocabulary of the accountability layer. Everything here is a
 * READ-MODEL shape over facts other modules already record (core activity,
 * response inbox, LinkedIn OS ledger, sender pools, poster) (see ARCHITECTURE.md).
 */

/* ------------------------------ events ---------------------------------- */

/** Normalized outbound event names (requirement: one vocabulary over every channel). */
export type OutboundEventType =
  | "EMAIL_SENT"
  | "EMAIL_REPLIED"
  | "EMAIL_POSITIVE_REPLY"
  | "LINKEDIN_CONNECTION_SENT"
  | "LINKEDIN_CONNECTION_ACCEPTED"
  | "LINKEDIN_MESSAGE_SENT"
  | "LINKEDIN_MESSAGE_REPLIED"
  | "LINKEDIN_VOICE_NOTE_SENT"
  | "LINKEDIN_INMAIL_SENT"
  | "LINKEDIN_PROFILE_VIEWED"
  | "LINKEDIN_POST_PUBLISHED"
  | "SMS_SENT"
  | "SMS_RECEIVED"
  | "SMS_OPT_OUT"
  | "VOICE_TOUCH_SENT"
  | "FOLLOW_UP_COMPLETED"
  | "MEETING_BOOKED"
  | "CANDIDATE_CONVERSATION_STARTED"
  | "BD_OPPORTUNITY_CREATED";

export interface OutboundEvent {
  id: string;
  workspaceId: string;
  /** Attributed user, or null when honestly unattributable (workspace-level). */
  userId: string | null;
  eventType: OutboundEventType;
  channel: "email" | "linkedin" | "sms" | "voice" | "content";
  motion: "bd" | "recruiting" | "unknown";
  at: string;
  campaignId?: string;
  prospectId?: string;
  provider?: string;
  sourceWorkflow?: string;
  metadata?: Record<string, unknown>;
}

/* ------------------------------ rollups --------------------------------- */

/** Per-user, per-day counters: the aggregation table the dashboards read. */
export interface DayCounts {
  bdEmailsSent: number;
  recruitingEmailsSent: number;
  liConnectionsSent: number;
  liConnectionsAccepted: number;
  liMessagesSent: number;
  liVoiceNotes: number;
  liInMails: number;
  liProfileViews: number;
  liPostsPublished: number;
  smsSent: number;
  smsReceived: number;
  smsOptOuts: number;
  voiceTouches: number;
  followUpsCompleted: number;
  repliesReceived: number;
  positiveReplies: number;
  meetingsBooked: number;
  candidateConversations: number;
  bdConversations: number;
}

export interface UserDayRollup {
  workspaceId: string;
  /** "" = the unattributed (workspace-level) bucket. */
  userId: string;
  day: string; // YYYY-MM-DD in the workspace's reporting timezone
  counts: DayCounts;
  /** Sends per hour (0-23) for pace analysis; only kept for recent days. */
  hourly?: number[];
  updatedAt: string;
}

/* ------------------------------ goals ----------------------------------- */

/** Daily activity targets. min = floor, target = expected, max = safe ceiling. */
export interface Band { min: number; target: number; max: number; }

export interface ChannelGoals {
  bdEmails: Band;
  recruitingEmails: Band;
  liConnections: Band;
  liMessages: Band;
  liVoiceNotes: Band;
  liProfileViews: Band;
  smsMessages: Band;
  followUps: Band;
  /** LinkedIn posts per WEEK (content cadence, not daily). */
  liPostsPerWeek: Band;
}

export interface TriggerThresholds {
  emailUtilNoonPct: number;        // warn if email utilization below this by noon
  emailUtilAfternoonPct: number;   // warn if below this by 3 PM
  linkedinUtilPct: number;         // daily LinkedIn utilization warning floor
  smsReplyWaitMinutes: number;     // SMS replies waiting longer than this
  noPostDays: number;              // days without a LinkedIn post
  bounceRatePct: number;
  optOutRatePct: number;
  responseDropPct: number;         // reply-rate drop vs baseline
  activityDropPct: number;         // outbound drop vs personal 30d baseline
  notLoggedInDays: number;
  underutilizedDays: number;       // consecutive days under floor before manager alert
  managerUtilFloorPct: number;     // avg utilization that triggers the manager alert
}

/** One tier of the config; fields absent = inherit from the tier above. */
export type GoalsPatch = {
  channels?: Partial<Record<keyof ChannelGoals, Partial<Band>>>;
  triggers?: Partial<TriggerThresholds>;
  /** Workspace-wide daily FIRST-email pool (e.g. 3000). Honored on the GLOBAL
   *  tier only. When > 0, each active recruiter's daily email target becomes
   *  pool ÷ recruiter count — recomputed live as recruiters join or leave, so
   *  the numbers every user sees always sum back to the pool. 0/unset = off
   *  (the per-channel bands below apply as usual). */
  dailyEmailPool?: number;
  workingDays?: number[];          // 0=Sun..6=Sat
  workHoursStart?: number;         // local hour 0-23
  workHoursEnd?: number;
  timezone?: string;
  morningHour?: number;            // daily summary send hour
  middayHour?: number;             // pace-check hour
  eodHour?: number;                // end-of-day report hour
  smsEnabled?: boolean;
  requiredCategories?: NotifyCategory[]; // categories users may NOT disable
};

/** Role tier keys. `member` is the base recruiter role; the rest are labels an
 *  admin can assign per user for goal purposes (the auth model has 3 roles). */
export type GoalRole =
  | "recruiter" | "senior_recruiter" | "recruiting_manager"
  | "business_development" | "account_executive" | "recruiting_operations" | "administrator";

export interface OutboundGoalsConfig {
  workspaceId: string;
  global: GoalsPatch;
  byRole: Partial<Record<GoalRole, GoalsPatch>>;
  byUser: Record<string, GoalsPatch>;
  /** Admin-assigned goal role per user (defaults derived from auth role). */
  userRoles: Record<string, GoalRole>;
  /** Per-user phone for SMS alerts (the auth user model has no phone field). */
  userPhones: Record<string, string>;
  updatedAt: string;
}

/** The team email pool resolved against the live roster. */
export interface EmailPoolSplit {
  total: number;         // the workspace-wide daily first-email pool
  recruiterCount: number;// active recruiters the pool divides across
  perRecruiter: number;  // floor(total / recruiterCount)
}

/** Fully-resolved goals for one user (inheritance applied). */
export interface ResolvedGoals {
  role: GoalRole;
  channels: ChannelGoals;
  /** Present when the workspace daily email pool is on; `applied` is true when
   *  THIS user is one of the recruiters the pool divides across (their email
   *  bands are pinned to their share). */
  emailPool?: EmailPoolSplit & { applied: boolean };
  triggers: TriggerThresholds;
  workingDays: number[];
  workHoursStart: number;
  workHoursEnd: number;
  timezone: string;
  morningHour: number;
  middayHour: number;
  eodHour: number;
  smsEnabled: boolean;
  requiredCategories: NotifyCategory[];
}

/* ----------------------------- capacity --------------------------------- */

export type ChannelKey = "email" | "linkedin" | "sms" | "followUp" | "content" | "response";

export type ChannelState = "strong" | "attention" | "underutilized" | "not_enabled" | "supply_constrained" | "system_limited";

export interface ChannelUtilization {
  key: ChannelKey;
  label: string;
  used: number;
  target: number;
  capacity: number;          // hard/safe ceiling actually available today
  remaining: number;
  utilizationPct: number;    // used / capacity (0 capacity => 0)
  targetPct: number;         // used / target
  state: ChannelState;
  /** Why the state is what it is (drives the heatmap cell drill-down). */
  reasons: string[];
  /** The specific next step ("Send 38 additional targeted BD emails today."). */
  recommendedAction?: string;
}

export interface SupplyView {
  /** Contacts ready to receive outreach right now (queued + gate-passing). */
  contactsReady: number;
  queuedTotal: number;
  activeCampaigns: number;
  /** True when capacity exists but supply can't fill it. */
  constrained: boolean;
  detail: string;
}

export interface SystemFactor {
  scope: ChannelKey | "global";
  severity: "info" | "warn" | "critical";
  reason: string;
}

export interface UserCapacity {
  userId: string;
  email: ChannelUtilization;
  linkedin: ChannelUtilization;
  sms: ChannelUtilization;
  followUp: ChannelUtilization;
  content: ChannelUtilization;
  response: ChannelUtilization;
  supply: SupplyView;
  systemFactors: SystemFactor[];
  /** Overall used/capacity across enabled outbound channels. */
  overallPct: number;
}

/* ------------------------------- score ---------------------------------- */

export interface ScoreComponent {
  key: ChannelKey;
  label: string;
  score: number;       // 0-100
  weight: number;      // effective weight after not_enabled reweighting
  state: ChannelState;
  detail: string;
}

export interface OutboundScore {
  total: number;       // 0-100
  components: ScoreComponent[];
  statusLine: string;  // "STRONG: FOLLOW-UP AND LINKEDIN CONTENT NEED ATTENTION"
}

/* ------------------------------ alerts ---------------------------------- */

export type AlertSeverity = "warning" | "critical" | "opportunity" | "achievement" | "info";
export type AlertAudience = "user" | "admin" | "both";

export interface OutboundAlert {
  id: string;
  workspaceId: string;
  userId: string | null;   // null = team-level
  audience: AlertAudience;
  severity: AlertSeverity;
  kind: string;            // stable trigger key, e.g. "email_below_pace_noon"
  title: string;
  detail: string;
  recommended?: string;
  day: string;
  at: string;
  readBy: string[];
}

/* --------------------------- notifications ------------------------------ */

export type NotifyCategory =
  | "daily_summary" | "underutilization" | "follow_up" | "campaign"
  | "posting" | "achievement" | "system";

export interface NotifyPrefs {
  inApp: boolean;
  email: boolean;
  sms: boolean;
  /** Per-category opt-outs; required categories are enforced server-side. */
  disabled: NotifyCategory[];
}

export interface OutboundNotification {
  id: string;
  workspaceId: string;
  userId: string;
  category: NotifyCategory;
  severity: AlertSeverity;
  title: string;
  body: string;            // plain text, short lines
  at: string;
  read: boolean;
  deliveredEmail?: boolean;
  deliveredSms?: boolean;
}

/* ------------------------------ checklist ------------------------------- */

export interface ChecklistStep {
  id: string;
  order: number;
  title: string;
  /** Numbers-first framing. */
  target: string;
  current: string;
  remaining: string;
  action: string;
  /** met = numbers satisfied; done = met or manually ticked. */
  met: boolean;
  done: boolean;
  minutes: number;         // suggested time budget for the step
  link?: string;           // in-app hash route to do the work
  state: ChannelState | "ok";
}

export interface DailyChecklist {
  day: string;
  userId: string;
  steps: ChecklistStep[];
  completedSteps: number;
  totalSteps: number;
  estimatedMinutes: number;
}

/* ------------------------------- audit ---------------------------------- */

export interface AuditEntry {
  id: string;
  workspaceId: string;
  adminId: string;
  adminEmail: string;
  change: string;          // human line, e.g. 'goals: role recruiter bdEmails.target'
  previous: unknown;
  next: unknown;
  at: string;
}
