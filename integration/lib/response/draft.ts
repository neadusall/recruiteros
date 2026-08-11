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

export type DraftObjective = "book_call" | "send_info" | "nudge" | "close_polite" | "forwardable";

export interface DraftContext {
  /** Recent conversation, oldest first: "THEM: ..." / "YOU: ...". */
  history: string[];
  /** Extra grounding lines: a fresh company signal, real open calendar slots, ... */
  extras?: string[];
  personName?: string;
  personTitle?: string;
  personCompany?: string;
  recruiterName?: string;
  classification: string;
  channel: "email" | "linkedin" | "sms";
}

const OBJECTIVES: Record<DraftObjective, string> = {
  book_call:
    // Active-thread stage: a SPECIFIC time-ask converts about 2.5x an open-ended
    // interest ask (the reverse is true cold, but a reply means the thread is live).
    "Objective: convert this into a short call. Propose TWO concrete windows in plain words (e.g. 'Tuesday morning or Wednesday right after lunch'), then add the booking link in one short sentence as the easier path if neither works. One ask total, no 'click here'.",
  send_info:
    "Objective: give them what they asked for, or promise it concretely. Answer their question directly first, then a soft next step. If they only said 'send me info', comply AND ask exactly one qualifying question (e.g. which role hurts most right now) so the info can be specific instead of a generic deck.",
  nudge:
    "Objective: a light follow-up on a thread that went quiet after interest. One or two sentences, zero guilt-tripping, add one NEW small piece of value or context rather than 'just bumping this'.",
  close_polite:
    "Objective: close gracefully. Thank them, leave the door open in one sentence, make it easy to come back later. No persuasion attempt.",
  forwardable:
    // Multithreading: deals with two-plus contacts win materially more often. When the
    // person is not the decision maker, arm them to carry it inside instead of dying with them.
    "Objective: they are not the decision maker, or this thread stalled with them. Write a note they can FORWARD internally: open with one short line to them ('if it is easier, feel free to pass this along'), then a self-contained paragraph anyone could read cold: who you are, the specific value for their team, one concrete proof point. End by asking them to send it to whoever owns hiring. No links except the booking link if one is provided.",
};

/**
 * Evidence-based objection handling for the classes where the person pushed
 * back. Encoded from staffing-industry playbooks: acknowledge, reposition,
 * de-risk, never argue.
 */
const OBJECTION_GUIDANCE: Record<string, string> = {
  fit_objection:
    "They pushed back on fit. Handle it the way top staffing operators do, WITHOUT arguing: " +
    "if they have internal recruiters, position as the partner for the hard or 60-plus-day searches their team would not fill anyway, not a replacement. " +
    "If they are happy with a current agency, expect nothing less and ask only to be the call when a niche search stalls. " +
    "If they had a bad agency experience, acknowledge it plainly, name one specific process difference, and offer references before any commitment.",
  timing_objection:
    "They said not now. Agree easily (never fight timing), name the window they gave back to them so they know you actually listened, and say you will circle back then. " +
    "Optionally offer one zero-effort value in the meantime, like flagging exceptional talent so they do not lose ground.",
  not_interested:
    "A clean no. Thank them, close warmly in two sentences, and leave one true sentence about when people usually come back to you. No persuasion.",
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
    OBJECTION_GUIDANCE[ctx.classification] || "",
    ...(ctx.extras || []),
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

/** The objective the drafter should default to for each reply class. */
export function objectiveForClass(cls: string): DraftObjective {
  if (cls === "positive") return "book_call";
  if (cls === "timing_objection") return "close_polite";
  return "send_info";
}

/**
 * Gather one row's full conversation and draft a reply for it. Shared by the
 * on-demand composer button and the on-arrival pre-drafter.
 */
export async function draftForRow(
  workspaceId: string,
  resp: ProcessedResponse,
  objective: DraftObjective,
  channel: DraftContext["channel"],
  recruiterName?: string,
): Promise<string> {
  const { getInbox } = await import("./repository");
  const { getCore } = await import("../core/repository");
  const prospect = resp.inbound.prospectId ? await getCore().getProspect(resp.inbound.prospectId) : undefined;
  const rows = await getInbox().forPerson(workspaceId, {
    prospectId: resp.inbound.prospectId,
    handles: [prospect?.email, prospect?.phone, prospect?.linkedinUrl, resp.inbound.fromHandle],
  });
  const notes = await getInbox().outboundForPerson(workspaceId, { prospectId: resp.inbound.prospectId, responseIds: rows.map((r) => r.inbound.id) });
  const history = [
    ...rows.map((r) => ({ at: r.inbound.receivedAt, line: "THEM: " + r.inbound.text.slice(0, 500) })),
    ...notes.map((n) => ({ at: n.at, line: "YOU: " + n.text.slice(0, 500) })),
  ].sort((x, y) => Date.parse(x.at) - Date.parse(y.at)).map((x) => x.line);

  // Grounding that measurably lifts outcomes, gathered best-effort: a draft
  // without extras is always better than no draft.
  const extras: string[] = [];
  if (objective === "nudge" && prospect?.company) {
    // Signal-stacked nudge: a follow-up that arrives BECAUSE something happened
    // at their company reads like attention, not persistence.
    try {
      const { queryPool } = await import("../inmarket/pool");
      const leads = await queryPool({ companyName: prospect.company } as any, 1);
      if (leads[0]?.reason) {
        extras.push(`Fresh signal about ${prospect.company}, use it naturally ONLY if it genuinely fits the thread: ${leads[0].reason}.`);
      }
    } catch { /* nudge still drafts without the signal */ }
  }
  if (objective === "book_call") {
    // Real availability: the two concrete windows are actual open slots on the
    // calendar, so an accepted time never needs a reschedule.
    try {
      const { getSettings } = await import("../inmarket/videoSettings");
      const { listOpenSlots } = await import("../inmarket/booking");
      const open = await listOpenSlots(workspaceId, await getSettings(workspaceId));
      const picks: string[] = [];
      for (const d of open.days) {
        if (picks.length >= 2) continue;
        const slot = d.slots[Math.min(2, d.slots.length - 1)];
        if (slot) picks.push(`${d.label} at ${slot.label} ${open.tzLabel}`);
      }
      if (picks.length >= 2) {
        extras.push(`These two windows are genuinely open on the calendar right now; use them as the concrete options: ${picks[0]} or ${picks[1]}.`);
      }
    } catch { /* generic two-windows language still applies */ }
  }

  return draftReply(resp, objective, {
    history,
    extras,
    personName: resp.inbound.fromName || prospect?.fullName,
    personTitle: prospect?.title,
    personCompany: prospect?.company,
    recruiterName,
    classification: resp.classification.class,
    channel,
  });
}

/**
 * Pre-draft on arrival: the reply is waiting in the composer before the recruiter
 * even opens the thread. Fire-and-forget from the ingest pipeline; failures are
 * silent (the composer button still drafts on demand).
 */
export async function preDraft(workspaceId: string, resp: ProcessedResponse): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const cls = resp.classification.class;
  if (!["positive", "soft_yes", "referral", "timing_objection"].includes(cls)) return;
  // Identity-verified only: never spend a draft on warm-up traffic.
  if (!resp.inbound.prospectId && !resp.inbound.campaignId) return;
  const channel = (["email", "linkedin", "sms"].includes(resp.inbound.channel) ? resp.inbound.channel : "email") as DraftContext["channel"];
  const objective = objectiveForClass(cls);
  try {
    const text = await draftForRow(workspaceId, resp, objective, channel);
    const { getInbox } = await import("./repository");
    await getInbox().setSuggested(workspaceId, resp.inbound.id, { text, objective, at: new Date().toISOString() });
  } catch { /* on-demand drafting still works */ }
}
