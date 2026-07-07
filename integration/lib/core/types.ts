/**
 * RecruitersOS · Core domain
 *
 * The shared models both operating systems run on: the Recruiting OS (placements)
 * and the Business Development OS (job orders). One campaign is the atomic unit;
 * a single hiring signal can create a placement AND a client at once, so the BD
 * and Recruiting motions deliberately share these types.
 *
 * Modeled on the GTM-OS reference (Overview / Campaigns / Prospects / Outreach /
 * Accounts / Connected / ATS / Response), mapped onto RecruitersOS naming.
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
  /** Recruiter-side MPC personalization ({{Your_Name}}, your recent placement city/role, …).
   *  Set ONCE on the campaign; enrollment stamps it onto every prospect so the Day-0 MPC
   *  templates render fully personal. Without it the render guard holds sends that need it. */
  mpcContext?: MpcContext;
  /** Outreach-Statistics promote-winners config (continuously refreshed when on). */
  autopilot?: CampaignAutopilot;
  /**
   * Hands-off run mode. When true, the internal Automation scheduler runs this
   * campaign end-to-end with NO human in the loop: it drafts on the daily
   * cadence, AUTO-APPROVES those drafts (skipping the 8:30 approval queue), and
   * pushes them to the channels — then the sequence/voice/nurture ticks carry
   * every prospect forward. When false/unset, drafts still generate but wait in
   * the approval queue for a human to approve (the current default behavior).
   * This is the per-campaign "Autopilot" switch that replaces the external
   * n8n conductor — the portal becomes its own clock. Gated globally by the
   * AUTOMATION_ENABLED env so the whole engine has one master kill switch.
   */
  autoRun?: boolean;
  /**
   * The approved outreach MODEL — the LLM-drafted, merge-field sequence templates
   * a human reviews and signs off ONCE before this campaign is allowed to run
   * hands-off. "See the models, approve the outreach, then set it and forget it":
   * `model` holds the drafted templates; `outreachApproved` is the gate. The
   * Autopilot runner refuses to send for a campaign whose model isn't approved,
   * and renders every ongoing send by merge-filling these approved templates
   * (no per-send LLM — the copy stays exactly what was approved).
   */
  model?: CampaignModel;
  outreachApproved?: boolean;
  /** Marks this as a SEND QUEUE campaign (the auto-fill target). When set, the autopilot (a) holds a
   *  prospect's FIRST email until it is fully send-ready (verified email + composed 2nd-email video +
   *  watch page), so every started sequence has its next-day video ready, and (b) its model is timed
   *  Day-0 text + Day-1 video. Opt-in + fail-safe: it only HOLDS unready prospects, never sends more. */
  sendQueue?: boolean;
  /** Optional launch date (YYYY-MM-DD) for this campaign's batch, so the Send Queue can show campaigns
   *  by the day they're slated to go out. */
  scheduledFor?: string;
  /** The recruiter (member userId) whose sender-inbox pool this campaign sends
   *  from. Set at deploy; the send path rotates across that recruiter's inboxes
   *  (see lib/senders/pool.ts pickSender). */
  recruiterId?: string;
  updatedAt?: string;
}

/** One templated step in an approved campaign model. Bodies/subjects carry merge
 *  fields ({{firstName}}, {{company}}, {{title}}, {{role}}, {{signal}}) filled
 *  per prospect at send time. `day` is the delay from enrollment the step fires. */
export interface CampaignModelTouch {
  key: string;
  day: number;
  channel: "email" | "linkedin" | "voice";
  /** For LinkedIn: "connect" | "message" | "voice_note". */
  action?: string;
  label: string;
  subject?: string;
  body: string;
}

/** The LLM-drafted, human-approved outreach model for a campaign. */
export interface CampaignModel {
  generatedAt: string;
  approvedAt?: string;
  /** The LLM that wrote it (audit), or "library" when the template fallback ran. */
  engine: string;
  motion: Motion;
  persona?: string;
  /** A one-line description of the strategy, for the review screen. */
  summary?: string;
  touches: CampaignModelTouch[];
}

/** A person we are reaching: a BD buyer or a candidate. */
/** Recruiter-side personalization for the MPC Day-0 sequence: YOUR recent placement + sign-off.
 *  Lives on the Campaign (set once) and is stamped onto every prospect at enrollment so
 *  renderTouch can resolve {{Your_Name}}/{{Near_City}}/{{Job_Title}}/… per send. */
export interface MpcContext {
  placedRole?: string;         // the role you recently placed (drives {{Job_Title}})
  placementLocation?: string;  // where you placed it (resolved to {{Near_City}} + local vernacular)
  competitor?: string;         // where you placed it (drives {{Competitor}})
  industry?: string;           // {{Industry}}
  mustHaves?: string[];        // native JD proof clauses -> {{MH1}} / {{MH2}}
  metric?: string;             // {{Metric}}
  gender?: "m" | "f";          // pronouns {{P_subj}} / {{P_obj}} / {{P_pos}} (never "they")
  yourName?: string;           // sign-off {{Your_Name}}
}

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
  /** The specific sender inbox (lib/senders) this prospect was sent from, stamped
   *  when the rotation picks one at deploy. Lets replies + analytics tie back to
   *  the exact Email ID, and keeps a prospect on one inbox across a sequence. */
  senderInboxId?: string;
  fullName: string;
  firstName: string;
  email?: string;
  /** Email deliverability verdict, stamped by the verifier (Reoon mailbox check,
   *  opt-in SMTP probe, or zero-config DNS/domain check). Drives the Clients book and
   *  gates sending: only "valid" is a mailbox-CONFIRMED send-ready address; "deliverable"
   *  passed syntax + real MX but the individual mailbox wasn't confirmed (no verifier
   *  configured); "risky" = catch-all/role/inbox-full; "invalid" = dead; "unknown" =
   *  transient/couldn't determine. Set REOON_API_KEY to upgrade deliverable → valid. */
  emailVerification?: {
    status: "valid" | "deliverable" | "risky" | "invalid" | "unknown";
    reason?: string;
    source?: "reoon" | "smtp" | "dns";
    checkedAt: string;
  };
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
  /** Context for the MPC Day-0 sequence (lib/bd/mpc): the recruiter's recent placement + the candidate
   *  being marketed. When set, renderTouch resolves rich {{Near_City}}/{{MH1}}/{{P_subj}}/… tokens; when
   *  absent, the sequence still renders truthfully-generic native copy from the lexicon floor.
   *  Stamped from the campaign's mpcContext at enrollment (enrollToBulk / autopilot enroll). */
  mpcContext?: MpcContext;
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
  /** Current drip touch (1..7), or null when paused / not yet sequenced. Under
   *  Autopilot this is the count of approved-model touches already sent. */
  dripStage: number | null;
  /** When the Autopilot runner first enrolled this prospect into the model — the
   *  clock the per-day model touches are paced against. */
  sequenceStartedAt?: string;
  /** 0..100 composite warmth/intent score; >= voiceNoteThreshold unlocks voice. */
  warmth: number;
  /** Stamped when status flips to "booked". */
  bookedAt?: string;
  /** Mirror of the ATS person id once synced. */
  atsPersonId?: string;
  /** A personalized picture-in-picture role video attached from the PiP Studio. Exposed to
   *  sequence templates as the merge fields {{watchlink}}, {{videogif}}, {{videoembed}} so the
   *  outreach email/DM can show this prospect's own clickable video of their hiring signal. */
  personalizedVideo?: {
    videoKey: string;
    watchUrl: string;
    gifUrl: string;
    mp4Url?: string;
    /** Signed static poster JPEG (frame + play button) — fallback email thumbnail; the animated
     *  teaser GIF (also carrying the baked play button) is the primary Loom-style embed. */
    posterUrl?: string;
    roleTitle?: string;
    /** The attached outreach SEQUENCE: email 1 is text-only, email 2 is the video follow-up. */
    sequence?: {
      firstEmail: { subject: string; body: string };
      secondEmail: { subject: string; body: string };
    };
    /** Share-link expiry (epoch ms; 0 = never) so the UI can warn before links go stale. */
    expiresAt?: number;
    at: string;
  };
  /** Set when the render guard (lib/copy/renderGuard) HELD this prospect's next touch at send
   *  time — the rendered copy had missing data points or read broken, so nothing was sent and the
   *  sequence did not advance. Re-evaluated every autopilot tick; cleared on the next clean send.
   *  `reasons` lists the exact failed checks so the operator can fix the data. */
  copyHold?: {
    at: string;
    touch: string;
    reasons: string[];
  };
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
