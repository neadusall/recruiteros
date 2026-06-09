/**
 * RecruiterOS · Response
 * The classification + routing matrix.
 *
 * This is the literal table from the reference Response tab, encoded so the
 * router executes it deterministically. Edit here to change inbox behavior;
 * the rest of the engine reads the rule, it does not hard-code class handling.
 */

import type { ResponseClass, RoutingRule } from "./types";

export const ROUTING_RULES: Record<ResponseClass, RoutingRule> = {
  positive: {
    class: "positive",
    label: "Positive",
    triggers: ["yes", "tell me more", "booking-link click", "let's talk"],
    actions: [
      { kind: "push_notification", detail: "Hot lead, call within 24h" },
      { kind: "send_booking_link", detail: "Tactful earned-ask + calendar link" },
      { kind: "pause_all_sequences" },
      { kind: "set_status", detail: "replied" },
      { kind: "log_activity", detail: "Positive reply" },
    ],
    sla: "same_day",
    escalate: true,
  },
  soft_yes: {
    class: "soft_yes",
    label: "Soft yes",
    triggers: ["has a question", "asks for details", "requests an asset", "what's the comp / stack"],
    actions: [
      { kind: "send_asset" },
      { kind: "tag", detail: "engaged" },
      { kind: "advance_step" },
      { kind: "log_activity", detail: "Soft yes, asset sent" },
    ],
    sla: "four_hours",
    escalate: true,
  },
  timing_objection: {
    class: "timing_objection",
    label: "Timing",
    triggers: ["not now", "next quarter", "circle back in Q3", "after summer"],
    actions: [
      { kind: "capture_field", detail: "timing" },
      { kind: "nurture", detail: "90-day" },
      { kind: "set_status", detail: "nurture" },
      { kind: "log_activity", detail: "Timing objection -> 90-day nurture" },
    ],
    sla: "same_day",
    escalate: false,
  },
  fit_objection: {
    class: "fit_objection",
    label: "Fit",
    triggers: ["we recruit internally", "not a fit", "happy with current"],
    actions: [
      { kind: "nurture", detail: "6-month" },
      { kind: "tag", detail: "suppress-signals" },
      { kind: "set_status", detail: "nurture" },
      { kind: "log_activity", detail: "Fit objection -> 6-month nurture" },
    ],
    sla: "same_day",
    escalate: false,
  },
  referral: {
    class: "referral",
    label: "Referral",
    triggers: ["talk to X", "not me, but", "reach out to my colleague"],
    actions: [
      { kind: "capture_field", detail: "referralTo" },
      { kind: "tag", detail: "advocate" },
      { kind: "push_notification", detail: "New referral captured" },
      { kind: "log_activity", detail: "Referral captured, original tagged advocate" },
    ],
    sla: "same_day",
    escalate: true,
  },
  not_interested: {
    class: "not_interested",
    label: "Not interested",
    triggers: ["no thanks", "not interested", "pass"],
    actions: [
      { kind: "pause_all_sequences" },
      { kind: "set_status", detail: "closed_lost" },
      { kind: "log_activity", detail: "Clean no -> closed lost" },
    ],
    sla: "same_day",
    escalate: false,
  },
  stop: {
    class: "stop",
    label: "STOP",
    triggers: ["stop", "unsubscribe", "remove me", "do not contact", "opt out"],
    actions: [
      { kind: "suppress_all" },
      { kind: "set_status", detail: "do_not_contact" },
      { kind: "log_activity", detail: "Opt-out honored, suppressed all channels" },
    ],
    sla: "immediate",
    escalate: false,
  },
  unclassified: {
    class: "unclassified",
    label: "Needs review",
    triggers: ["ambiguous", "classifier abstained"],
    actions: [
      { kind: "push_notification", detail: "Reply needs human review" },
      { kind: "log_activity", detail: "Unclassified, queued for review" },
    ],
    sla: "same_day",
    escalate: true,
  },
};

export function ruleFor(cls: ResponseClass): RoutingRule {
  return ROUTING_RULES[cls] ?? ROUTING_RULES.unclassified;
}

/** Stable order for the inbox: hottest first. */
export const CLASS_ORDER: ResponseClass[] = [
  "positive",
  "referral",
  "soft_yes",
  "unclassified",
  "timing_objection",
  "fit_objection",
  "not_interested",
  "stop",
];
