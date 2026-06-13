/**
 * RecruitersOS · Response (the Money Maker)
 * Types for the unified response inbox + auto-classification + routing.
 *
 * Mirrors the GTM-OS "Response" tab: every reply across email, LinkedIn and SMS
 * lands in one inbox, Claude classifies it, and deterministic routing rules pause
 * sequences, escalate hot leads, capture timing/referrals, or suppress.
 */

import type { Channel } from "../core/types";

/** The classes the reference inbox sorts every inbound reply into. */
export type ResponseClass =
  | "positive"          // "yes", "tell me more", booking-link click
  | "soft_yes"          // asks a question / requests an asset
  | "timing_objection"  // "not now", "next quarter"
  | "fit_objection"     // "we do internal recruiting"
  | "referral"          // "talk to X"
  | "not_interested"    // a clean no, no hostility
  | "stop"              // "stop" / "remove" / unsubscribe
  | "unclassified";     // classifier abstained; needs human review

/** Where an inbound reply came from. */
export type ResponseSource = "instantly" | "unipile" | "salesrobot" | "taltxt";

/** A normalized inbound reply, channel-agnostic. */
export interface InboundResponse {
  id: string;
  workspaceId: string;
  prospectId: string | null;     // null until matched to a prospect
  channel: Channel;
  source: ResponseSource;
  /** Provider's id for the inbound message (idempotency key). */
  providerMessageId: string;
  fromName?: string;
  fromHandle?: string;           // email / linkedin url / phone
  text: string;
  receivedAt: string;
  campaignId?: string;
}

/** Routing SLA buckets from the reference matrix. */
export type Sla = "immediate" | "same_day" | "four_hours";

/** One discrete action the router can execute for a class. */
export type RoutingActionKind =
  | "push_notification"   // ping the recruiter
  | "pause_all_sequences" // stop every channel for this prospect
  | "advance_step"        // soft yes: send asset + nudge forward one touch
  | "send_booking_link"   // positive: send the tactful earned-ask + calendar link
  | "send_asset"          // attach the campaign's case study / comp benchmark
  | "tag"                 // tag in the ATS ("engaged", "advocate", ...)
  | "set_status"          // flip the prospect lifecycle status
  | "nurture"             // move to a timed nurture track
  | "capture_field"       // record timing / referral target
  | "suppress_all"        // STOP: do-not-contact across every channel
  | "log_activity";       // always: write the person_event

export interface RoutingAction {
  kind: RoutingActionKind;
  detail?: string;
}

/** The full routing rule for one class. */
export interface RoutingRule {
  class: ResponseClass;
  /** Human label for the inbox badge. */
  label: string;
  /** Example triggers shown in the rules table. */
  triggers: string[];
  /** Ordered actions the router executes. */
  actions: RoutingAction[];
  sla: Sla;
  /** True when a human should take the conversation now. */
  escalate: boolean;
}

/** Claude's classification verdict. */
export interface Classification {
  class: ResponseClass;
  confidence: number;     // 0..1
  /** Captured slot value for timing / referral classes. */
  captured?: { timing?: string; referralTo?: string };
  reasoning?: string;
}

/** The result of running one inbound reply all the way through the pipeline. */
export interface ProcessedResponse {
  inbound: InboundResponse;
  classification: Classification;
  rule: RoutingRule;
  actionsTaken: string[];
  atsEventId?: string;
}
