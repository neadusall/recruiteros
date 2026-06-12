/**
 * RecruiterOS · Core domain
 *
 * The shared models both operating systems run on: the Recruiting OS (placements)
 * and the Business Development OS (job orders). One campaign is the atomic unit;
 * a single hiring signal can create a placement AND a client at once, so the BD
 * and Recruiting motions deliberately share these types.
 *
 * Modeled on the GTM-OS reference (Overview / Campaigns / Prospects / Outreach /
 * Accounts / Connected / ATS / Response), mapped onto RecruiterOS naming.
 */

/** Which operating system a campaign belongs to. */
export type Motion = "bd" | "recruiting";

/** Every channel the platform can send and receive on. */
export type Channel = "email" | "linkedin" | "sms" | "voice";

/**
 * The prospect lifecycle, shared across both motions. The labels differ in the
 * UI per motion (BD: "Discovery booked" / "Mandate signed"; Recruiting:
 * "Submitted" / "Placed") but the underlying stages are the same.
 */
export type ProspectStatus =
  | "queued"          // discovered, awaiting the morning approval queue
  | "in_sequence"     // active multi-channel drip
  | "replied"         // any reply on any channel -> all sequences paused
  | "booked"          // discovery call booked (BD) / candidate submitted (recruiting)
  | "won"             // mandate signed (BD) / placed (recruiting)
  | "nurture"         // 90-day or 6-month nurture track
  | "closed_lost"
  | "do_not_contact"; // suppressed across all channels

/** The ideal-customer / ideal-candidate profile that scopes a campaign. */
export interface ICP {
  /** Account-side profile, e.g. "Series A-C fintech, 50-300 headcount, EU". */
  accountProfile: string;
  /** Persona to reach, e.g. "VP Engineering" (BD) or "Senior React" (recruiting). */
  persona: string;
  /** Hard disqualifiers that suppress a match, e.g. ["has internal TA team"]. */
  disqualifiers: string[];
}

/** Buying / hiring signals a campaign listens for. */
export type SignalKind =
  | "fundraising"
  | "hiring_velocity"
  | "leadership_change"
  | "expansion"
  | "layoff"
  | "tech_adoption";

/** Per-campaign channel wiring (the "Connect Channels" phase). */
export interface ChannelConfig {
  instantlyCampaignId?: string;  // email (Instantly)
  linkedinAccountId?: string;    // LinkedIn (Unipile / SalesRobot)
  smsEnabled?: boolean;          // SMS (TalTxt + Telnyx 10DLC)
  loxoListId?: string;           // ATS list to sync into
}

/**
 * One step in a visually built sequence (the Campaign Studio drag-and-drop
 * canvas). `key` identifies the block (e.g. "li_connect", "em_cold",
 * "sms_send", "lg_delay"); `channel` routes the send; `delay` is the wait in
 * days before the step fires; `cfg` holds the per-step config (subject, body,
 * condition, A/B weights, assignee...).
 */
export interface SequenceStep {
  uid: string;
  key: string;
  channel: Channel | "logic";
  label: string;
  ic?: string;
  delay?: number;
  cfg?: Record<string, unknown>;
}

/** A campaign: the unit of work for a targeting motion. */
export interface Campaign {
  id: string;
  workspaceId: string;
  motion: Motion;
  name: string;
  goal: string;                  // one-sentence goal
  icp: ICP;
  signals: SignalKind[];
  channels: ChannelConfig;
  methodology: "hiring_manager_outreach" | "voice_first" | "seven_touch_drip";
  /** Score at/above which a Day-14 voice note is allowed (HOT tier, default 80). */
  voiceNoteThreshold: number;
  dailyCap: number;
  status: "draft" | "active" | "paused";
  createdAt: string;
  /** The visually built multi-channel sequence (Campaign Studio). Optional so
   *  older signal-only campaigns stay valid. */
  sequence?: SequenceStep[];
  /** Who owns running this campaign (teammate name or "Round-robin team"). */
  assignee?: string;
  /** The sending account/handle this campaign uses (or "auto-rotate"). */
  senderAccount?: string;
  /** Outreach-Statistics promote-winners config (continuously refreshed when on). */
  autopilot?: CampaignAutopilot;
  updatedAt?: string;
}

/** A person we are reaching: a BD buyer or a candidate. */
export interface Prospect {
  id: string;
  workspaceId: string;
  campaignId: string;
  /** Which motion's bucket this prospect belongs to (recruiting vs BD), so
   *  scrapes/imports land only in the active motion's pipeline. */
  motion?: Motion;
  /** The recruiter (member) who owns this prospect — the user who created or
   *  imported it. Powers the per-recruiter Dashboard drill-down. Unset for
   *  legacy/admin-created records (counted only in the workspace-wide view). */
  ownerId?: string;
  fullName: string;
  firstName: string;
  email?: string;
  linkedinUrl?: string;
  /** Primary outreach number (SMS/voice). Defaults to mobile when known. */
  phone?: string;
  /** Mobile number, enriched as its own field (separate provider rung). */
  mobilePhone?: string;
  /** Landline / direct-dial number, enriched separately from mobile. */
  landlinePhone?: string;
  company?: string;
  /** The prospect's company domain — pairs the person to their company so the
   *  enrichment waterfall can resolve a company email + phone for outreach. */
  companyDomain?: string;
  title?: string;
  /** Profile photo URL (e.g. captured from a LinkedIn/Sales Nav search). */
  photoUrl?: string;
  /** City / region as shown on the profile. */
  location?: string;
  /** One-line LinkedIn headline. */
  headline?: string;
  /** ICP category bucket this prospect was matched into. */
  category?: string;
  /** The hiring/buying signal that surfaced this prospect (SignalType, e.g.
   *  "job_repost"). Carried from Hire Signals so the outreach drafter speaks to
   *  the actual REASON, not a generic opener. */
  signalType?: string;
  /** Human reason string for that signal, e.g. "Reposted the role twice in 30 days". */
  signalReason?: string;
  /** Assigned sequence (from the Campaign Sequences Library), by id + name. */
  sequenceId?: string;
  sequenceName?: string;
  status: ProspectStatus;
  /** The channel the most recent inbound arrived on. */
  lastChannel?: Channel;
  /** Current drip touch (1..7), or null when paused / not yet sequenced. */
  dripStage: number | null;
  /** 0..100 composite warmth/intent score; >= voiceNoteThreshold unlocks voice. */
  warmth: number;
  /** Stamped when status flips to "booked". */
  bookedAt?: string;
  /** Mirror of the ATS person id once synced. */
  atsPersonId?: string;
  createdAt: string;
}

/** A single logged touch or system action, mirrored to the ATS as a person_event. */
export interface ActivityEvent {
  id: string;
  workspaceId: string;
  prospectId: string;
  channel: Channel | "system";
  /** e.g. "email_sent", "reply_received", "discovery_call_booked", "suppressed". */
  type: string;
  summary: string;
  at: string;
  /** Set once the ATS confirms the person_event. */
  atsEventId?: string;
  /** Outreach-analytics dimensions, stamped on sends so the Outreach Statistics
   *  rollup can attribute every touch. Optional: legacy events lack them. */
  campaignId?: string;
  /** A/B variant or message archetype label (e.g. "fintech/vp/director"). */
  variant?: string;
  /** Sequence touch name (e.g. "Signal Opener", "Break-up"). */
  touch?: string;
}

/** Outreach Statistics "promote winners" output, written onto a campaign. When
 *  enabled it is continuously refreshed each cadence run, so the campaign stays
 *  tuned to what is actually converting — the hands-off loop. */
export interface CampaignAutopilot {
  enabled: boolean;
  appliedAt?: string;
  /** The message archetype / A/B variant winning on positive-reply rate. */
  winningVariant?: string;
  /** Segments (industry/function/seniority) with the best positive-reply rate. */
  winningSegments?: string[];
  /** Best send hour (0-23) by reply rate. */
  bestSendHour?: number;
  /** Channels ordered best-first by positive-reply rate. */
  channelEmphasis?: Channel[];
  /** Human summary of what was applied. */
  note?: string;
}
