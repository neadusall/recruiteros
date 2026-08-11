/**
 * RecruitersOS · Response · AI reply drafting
 *
 * One-click suggested replies in the reply center. The recruiter picks an
 * objective (book a call, send info, nudge, polite close), Claude drafts a
 * short reply in their voice from the WHOLE conversation, and the text lands
 * in the composer to edit before sending. Nothing is ever auto-sent.
 *
 * Model: creation is pinned to Haiku for spend control, same as every other
 * email-creation path (does NOT follow RECRUITEROS_LLM_MODEL).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ProcessedResponse } from "./types";
import { sanitizeDashes } from "../bd/sanitize";
import { bookingUrl } from "../bd/booking";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.RECRUITEROS_EMAIL_MODEL ?? "claude-haiku-4-5";

export type DraftObjective = "book_call" | "send_info" | "nudge" | "close_polite";

export interface DraftContext {
  /** Recent conversation, oldest first: "THEM: ..." / "YOU: ...". */
  history: string[];
  personName?: string;
  personTitle?: string;
  personCompany?: string;
  recruiterName?: string;
  classification: string;
  channel: "email" | "linkedin" | "sms";
}

const OBJECTIVES: Record<DraftObjective, string> = {
  book_call:
    "Objective: convert this into a short call. Make ONE low-friction ask with the booking link woven in naturally (never 'click here'). Offer to work around their schedule.",
  send_info:
    "Objective: give them what they asked for, or promise it concretely. Answer their question directly first, then a soft next step. No booking pressure.",
  nudge:
    "Objective: a light follow-up on a thread that went quiet after interest. One or two sentences, zero guilt-tripping, add one NEW small piece of value or context rather than 'just bumping this'.",
  close_polite:
    "Objective: close gracefully. Thank them, leave the door open in one sentence, make it easy to come back later. No persuasion attempt.",
};

const CHANNEL_RULES: Record<DraftContext["channel"], string> = {
  email: "Channel: email reply. 2-5 short sentences, plain text, no subject line, no signature block (just end with the first name if a name is given).",
  linkedin: "Channel: LinkedIn message. 1-3 casual sentences, first-name basis, no links unless the objective requires the booking link.",
  sms: "Channel: SMS. Maximum 300 characters, warm and direct, no links unless the objective requires the booking link.",
};

/** Build a draft reply for one inbox row. Returns plain text ready for the composer. */
export async function draftReply(resp: ProcessedResponse, objective: DraftObjective, ctx: DraftContext): Promise<string> {
  const link = objective === "book_call" ? bookingUrl("consultative") : "";
  const system =
    "You draft replies a recruiter sends to prospects and candidates who answered their outreach. " +
    "You write like a busy, warm, competent human, never like software. Hard rules: " +
    "mirror the other person's tone and brevity; one clear next step maximum; no exclamation stacking; " +
    "no corporate filler ('I hope this finds you well', 'per my last'); never mention AI; " +
    "never use an em-dash; plain text only. Return ONLY the reply text, nothing else.";
  const user = [
    `The prospect${ctx.personName ? " " + ctx.personName : ""}${ctx.personTitle ? ", " + ctx.personTitle : ""}${ctx.personCompany ? " at " + ctx.personCompany : ""} replied. Their reply was auto-classified as: ${ctx.classification}.`,
    "",
    "Conversation so far (oldest first):",
    ...ctx.history.slice(-10),
    "",
    OBJECTIVES[objective],
    CHANNEL_RULES[ctx.channel],
    link ? `Booking link to weave in: ${link}` : "",
    ctx.recruiterName ? `Sign off as ${ctx.recruiterName.split(" ")[0]}.` : "",
  ].filter(Boolean).join("\n");

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system,
    messages: [{ role: "user", content: user }],
  });
  const text = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  return sanitizeDashes(text);
}
