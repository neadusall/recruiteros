/**
 * RecruiterOS · BD · The earned ask (conversion layer)
 *
 * The opener + nurture deliberately never pitch — they earn attention. THIS is
 * where attention becomes a booked call, tactfully: once a prospect engages (a
 * positive reply) or has had several value touches, we make ONE low-friction,
 * value-framed ask with a calendar link. Never a demo-beg; always "here's
 * something useful, worth a short call or easier if I just send it over?".
 *
 * Config:
 *   RECRUITEROS_BOOKING_URL   the operator's calendar link (Cal.com / Calendly).
 *                             No URL set -> the ask is skipped and a human handles it.
 *   RECRUITEROS_BOOKING_MODE  "send" (default) auto-sends the ask via the owned MTA;
 *                             "draft" returns the copy for the operator to send in one click.
 */

import Anthropic from "@anthropic-ai/sdk";
import { sendEmail, mtaPreferred } from "../providers/mta";
import { toHtml } from "./draftContent";
import { inferPersona } from "./personaMessaging";
import { sanitizeDashes } from "./sanitize";
import type { Variant } from "./experiment";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

/**
 * Each A/B model books on its own TidyCal type so the funnels never cross:
 *   mpc          -> "Talent Intro" (lead with a specific candidate)
 *   consultative -> "TMI Exchange" (talent-market-intelligence working session)
 * Override per model with RECRUITEROS_BOOKING_URL_MPC / _CONSULTATIVE.
 */
const DEFAULT_BOOKING: Record<Variant, string> = {
  mpc: "https://tidycal.com/talco/talent-intro",
  consultative: "https://tidycal.com/talco/tmi-exchange",
};

export function bookingUrl(variant: Variant = "consultative"): string {
  const env = variant === "mpc" ? process.env.RECRUITEROS_BOOKING_URL_MPC : process.env.RECRUITEROS_BOOKING_URL_CONSULTATIVE;
  return (env || DEFAULT_BOOKING[variant]).trim();
}
export function bookingMode(): "send" | "draft" {
  return (process.env.RECRUITEROS_BOOKING_MODE || "send").toLowerCase() === "draft" ? "draft" : "send";
}

/**
 * Default calendar copy — also handed to the operator to paste into their booking
 * tool so the page itself keeps the low-pressure, advisory framing.
 */
export const CALL_TITLE = "A working conversation about your team";
export const CALL_DESCRIPTION =
  "A short, no-pressure call to understand what you're trying to build and where the gaps are. " +
  "Not a sales pitch and not a recruiting pitch. Come with the roles or the problems on your mind; " +
  "you'll leave with a clear read on the market, what comparable teams are doing, and a few concrete " +
  "options, whether or not we ever work together. 20 minutes, and you set the agenda.";

export interface AskLead {
  firstName?: string;
  fullName?: string;
  title?: string;
  company?: string;
  industry?: string;
  persona?: string;
  profileSummary?: string;
}

const ASK_SYSTEM_CONSULTATIVE = `You write a single, tactful message from a recruiting and talent advisor (Ryan / Lume) to an executive who has shown some interest, inviting them to a short working call. This is the ONE moment we ask for time, and it must feel like a generous offer, never a sales push.

Method (follow exactly):
- Open by acknowledging what they said or the moment, warmly and briefly.
- Lead with VALUE: name one specific, useful thing you can share that is relevant to their exact role and industry (what comparable teams are doing, a market read on their open roles, a concrete option). The value must be real and defensible from the context given; never invent specifics.
- Make the ask LOW-FRICTION and OPTIONAL, with a built-in easy out: offer a short call OR to simply send it over. Example shape: "Happy to walk you through what I'm seeing other [role]s do about [X], worth a quick call, or easier if I just send it over?"
- Frame the call as THEIRS: short (about 20 minutes), no pitch, they set the agenda, useful whether or not you ever work together.
- Include the calendar link plainly when one is provided.
- Never use pressure, false scarcity, "quick question", "circle back", flattery, or hype. No emojis, no hashtags, NO dashes of any kind (no em dashes, no en dashes, no hyphens; compounds as separate words). Plain text. Money in US dollars with $.
- Keep it short: email 60-110 words with a quiet, specific subject; linkedin 300-500 characters.

The reader should feel: "this person is genuinely offering me something useful and making it easy," never "this person is trying to get me on a sales call."`;

const ASK_SYSTEM_MPC = `You write a single, confident message from a well-connected recruiter (Ryan / Lume) to an executive who has shown some interest, inviting them to a short call to walk through a specific candidate. This is the forward Most-Placeable-Candidate ask: we have a strong, ready-to-move person who fits their world, and we lead with that.

Method (follow exactly):
- Open by acknowledging their interest, warmly and briefly.
- Lead with the CANDIDATE-AND-FIT: a strong [function/level] professional we represent, open to the right move, whose background fits what they are likely building. Tie it to their role/industry/signal.
- Create honest momentum: strong people in motion don't stay available long, so a quick look makes sense now. You may note timing matters; you may NOT invent deadlines, competing offers, names, metrics, or any candidate detail you were not given.
- Make the ask LOW-FRICTION: a short call to walk the profile, OR offer to send a one-page summary. Easy out either way.
- Frame the call as theirs: about 20 minutes, no obligation.
- Include the calendar link plainly when one is provided.
- ABSOLUTE TRUTH: never fabricate a candidate, name, number, client, or outcome. If no real candidate detail is provided, speak truthfully and generally about the talent we represent in their market; never invent a specific person.
- No pressure beyond honest timing, no flattery, no hype, no emojis, no hashtags, NO dashes of any kind (no em dashes, no en dashes, no hyphens; compounds as separate words). Plain text. US dollars with $.
- Keep it short: email 60-110 words with a quiet, specific subject; linkedin 300-500 characters.

The reader should feel: "this person has someone I should actually meet," never "this is a mass sales pitch."`;

/** Generate the earned-ask message for one lead on one channel, in the given A/B model. */
export async function generateEarnedAsk(
  lead: AskLead,
  opts: { channel: "email" | "linkedin"; priorContext?: string; variant?: Variant; candidate?: string } = { channel: "email" },
): Promise<{ subject?: string; body: string }> {
  const url = bookingUrl(opts.variant ?? "consultative");
  const system = opts.variant === "mpc" ? ASK_SYSTEM_MPC : ASK_SYSTEM_CONSULTATIVE;
  const brief = [
    lead.fullName ? `Name: ${lead.fullName}` : null,
    lead.title ? `Title: ${lead.title}` : null,
    lead.company ? `Company: ${lead.company}` : null,
    lead.industry ? `Industry: ${lead.industry}` : null,
    lead.persona ? `Persona: ${lead.persona}` : null,
    lead.profileSummary ? `Their background (REAL): ${lead.profileSummary}` : null,
    opts.candidate ? `Candidate to lead with (REAL, anonymized, MPC only): ${opts.candidate}` : null,
    opts.priorContext ? `What they just said (respond to this): ${opts.priorContext}` : null,
    url ? `Calendar link to include: ${url}` : `Calendar link: (none configured - invite them to reply with a time instead)`,
  ].filter(Boolean).join("\n");

  const shape = opts.channel === "email" ? `{ "subject": string, "body": string }` : `{ "body": string }`;
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] as any,
    messages: [{ role: "user", content: `Channel: ${opts.channel}\n\nLEAD:\n${brief}\n\nRespond as strict JSON ${shape} and nothing else.` }],
  });

  const raw = resp.content.find((b) => b.type === "text");
  const text = raw && raw.type === "text" ? raw.text : "{}";
  let o: Record<string, unknown> = {};
  try {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s >= 0) o = JSON.parse(text.slice(s, e + 1));
  } catch {
    /* empty -> body "" */
  }
  let body = typeof o.body === "string" ? sanitizeDashes(o.body.trim()) : "";
  // Belt-and-suspenders: make sure the link is actually present on email asks
  // (appended AFTER sanitizing, and sanitizeDashes protects URLs anyway).
  if (url && body && !body.includes(url)) body += `\n\n${url}`;
  return { subject: typeof o.subject === "string" ? sanitizeDashes(o.subject.trim()) : undefined, body };
}

export interface BookingAskResult {
  ok: boolean;
  mode: "send" | "draft" | "skipped";
  provider?: string;
  draft?: { subject?: string; body: string };
  detail?: string;
}

/**
 * Generate + deliver the earned ask for a prospect who engaged. In "send" mode it
 * goes out now via the owned MTA; in "draft" mode (or with no email / MTA) it
 * returns the copy for the operator to send in one click. No-ops if no calendar
 * link is configured, so a human takes the conversation.
 */
export async function sendBookingAsk(
  workspaceId: string,
  p: { email?: string; firstName?: string; fullName?: string; title?: string; company?: string; industry?: string; profileSummary?: string },
  opts: { priorContext?: string; variant?: Variant; candidate?: string } = {},
): Promise<BookingAskResult> {
  if (!bookingUrl(opts.variant ?? "consultative")) return { ok: false, mode: "skipped", detail: "no_booking_url" };

  const lead: AskLead = {
    firstName: p.firstName,
    fullName: p.fullName,
    title: p.title,
    company: p.company,
    industry: p.industry,
    persona: inferPersona(p.title),
    profileSummary: p.profileSummary,
  };
  const ask = await generateEarnedAsk(lead, { channel: "email", priorContext: opts.priorContext, variant: opts.variant, candidate: opts.candidate });

  if (bookingMode() === "draft" || !p.email || !mtaPreferred()) {
    return { ok: true, mode: "draft", draft: ask, detail: !p.email ? "no_email" : undefined };
  }
  const m = await sendEmail(workspaceId, { to: p.email, subject: ask.subject ?? CALL_TITLE, htmlBody: toHtml(ask.body) });
  return { ok: m.ok, mode: "send", provider: m.provider, detail: m.skipped, draft: ask };
}
