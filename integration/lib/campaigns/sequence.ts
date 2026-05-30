/**
 * RecruiterOS · Campaigns
 * The 28-day multi-channel sequence anatomy, encoded.
 *
 * This is the reference "Sequence Anatomy" + "Per-Channel Touch Reference" as
 * data: email (7 touches, Instantly), LinkedIn (6 touches, Unipile/SalesRobot),
 * a Day-14 voice note for HOT-tier, and post-engagement SMS (TalTxt). The daily
 * cadence and the LLM drafter read these specs to know what to generate and when.
 */

import type { Channel } from "../core/types";

export interface TouchSpec {
  channel: Channel;
  day: number;
  name: string;
  intent: string;
  /** Hard constraints the LLM drafter must honor. */
  constraints?: string;
  /** Only fires when prospect.warmth >= the campaign voiceNoteThreshold. */
  hotOnly?: boolean;
  /** Email-only: only continues if LinkedIn connect not accepted by Day 5. */
  fallback?: boolean;
}

export const EMAIL_TOUCHES: TouchSpec[] = [
  { channel: "email", day: 0, name: "Signal Opener", intent: "Hook on the trigger event; ask 'worth sending?' not 'book a call'.", constraints: "subject <= 8 words, body <= 90 words" },
  { channel: "email", day: 3, name: "Value Drop", intent: "Give a case study or comp benchmark, no ask. Builds reciprocity." },
  { channel: "email", day: 7, name: "Comparable Proof", intent: "Numbers + timeline from a comparable company." },
  { channel: "email", day: 12, name: "Interactive Question", intent: "One sharp question that invites a reply." },
  { channel: "email", day: 18, name: "Market View", intent: "Three bullets of sector-level insight." },
  { channel: "email", day: 24, name: "Direct Ask", intent: "Reference prior drops; calendar link.", constraints: "subject: '15 min next week?'" },
  { channel: "email", day: 28, name: "Break-up", intent: "Highest reply rate.", constraints: "subject: 'Should I close the file?'" },
];

export const LINKEDIN_TOUCHES: TouchSpec[] = [
  { channel: "linkedin", day: 0, name: "Profile view", intent: "Passive warmup." },
  { channel: "linkedin", day: 1, name: "Follow", intent: "Lower commitment than a connect." },
  { channel: "linkedin", day: 3, name: "Connect, no note", intent: "Empty requests accept higher." },
  { channel: "linkedin", day: 5, name: "Engage with a post", intent: "Manual comment; signals attention." },
  { channel: "linkedin", day: 7, name: "Signal-anchored DM", intent: "Same trigger as email touch 1.", constraints: "<= 45 words; requires accepted connection" },
  { channel: "linkedin", day: 21, name: "Direct DM ask", intent: "Calendar link, 15 min." },
];

export const VOICE_TOUCH: TouchSpec = {
  channel: "voice", day: 14, name: "Voice note", hotOnly: true,
  intent: "Reference one specific signal; ask for a thumbs-up, not a booking. Highest-converting single touch.",
  constraints: "25-30 seconds, recorded manually in the morning approval queue",
};

export const SMS_TOUCHES: TouchSpec[] = [
  { channel: "sms", day: 0, name: "SMS 1 (post-engagement)", intent: "Short, personal. Fires after a LinkedIn/email reply.", constraints: "<= 160 chars" },
  { channel: "sms", day: 3, name: "SMS 2", intent: "Value / context drop if no reply." },
];

/** Decision rules the engine enforces while a prospect runs the sequence. */
export const SEQUENCE_RULES = [
  "Reply on ANY channel -> pause ALL, notify user, status = replied.",
  "LinkedIn connect not accepted by Day 5 -> skip DM, email-only continues.",
  "Warmth >= voiceNoteThreshold (default 80) -> voice note enabled Day 14.",
  "Email bounce on Touch 1 -> suppress prospect, flag for re-enrichment.",
  "STOP / unsubscribe -> suppress all channels + do-not-contact list.",
  "Day 28 no reply -> move to 90-day nurture.",
] as const;

/** Full ordered timeline for a campaign, honoring the HOT-tier voice gate. */
export function timeline(warmth: number, threshold = 80): TouchSpec[] {
  const all = [...EMAIL_TOUCHES, ...LINKEDIN_TOUCHES, ...SMS_TOUCHES];
  if (warmth >= threshold) all.push(VOICE_TOUCH);
  return all.sort((a, b) => a.day - b.day);
}
