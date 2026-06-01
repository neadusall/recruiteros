/**
 * RecruiterOS · Response
 * AI classification of inbound replies (the inbox auto-sort).
 *
 * Heuristic fast-path for the unambiguous cases (STOP especially must be instant
 * and free), Claude for everything else. Returns a `Classification` plus any
 * captured slot (timing window / referral target).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Classification, ResponseClass } from "./types";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

const VALID: ResponseClass[] = [
  "positive", "soft_yes", "timing_objection", "fit_objection",
  "referral", "not_interested", "stop", "unclassified",
];

const SYSTEM = `You classify inbound replies to recruiter / business-development outreach. Return strict JSON only.
Classes:
- positive: clear interest, "yes", "tell me more", wants to talk / book.
- soft_yes: open but hedged, asks a question, requests details or an asset (comp, stack, case study).
- timing_objection: interested later, not now ("next quarter", "after summer"). Capture the timing window.
- fit_objection: not a fit / recruits internally / happy where they are.
- referral: points you to someone else. Capture who.
- not_interested: a clean no, no hostility.
- stop: asks to stop / unsubscribe / do not contact.
- unclassified: genuinely ambiguous; abstain rather than guess.
Capture timing for timing_objection and referralTo for referral when present.`;

/** Free, instant path for opt-outs and obvious booking intent. */
export function fastPath(text: string): Classification | null {
  const t = text.toLowerCase().trim();
  if (/\b(stop|unsubscribe|do not contact|remove me|opt[\s-]?out|take me off)\b/.test(t)) {
    return { class: "stop", confidence: 0.99, reasoning: "opt-out keyword" };
  }
  if (/\b(booked|calendly\.com|cal\.com\/|i picked|just grabbed a slot)\b/.test(t)) {
    return { class: "positive", confidence: 0.95, reasoning: "booking-link interaction" };
  }
  return null;
}

export async function classify(text: string): Promise<Classification> {
  const fast = fastPath(text);
  if (fast) return fast;

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 250,
      // cache_control is honored by the API but untyped in this SDK version.
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
      messages: [
        {
          role: "user",
          content:
            `Reply to classify:\n"""${text}"""\n\n` +
            `Respond as JSON: {"class": string, "confidence": number, ` +
            `"captured": {"timing"?: string, "referralTo"?: string}, "reasoning": string}.`,
        },
      ],
    });
    const block = res.content.find((b) => b.type === "text");
    return normalize(block && block.type === "text" ? block.text : "{}");
  } catch (err) {
    // Never drop a reply because the model is down; queue it for a human.
    return { class: "unclassified", confidence: 0, reasoning: `classifier_error: ${String(err)}` };
  }
}

function normalize(s: string): Classification {
  try {
    const o = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
    const cls: ResponseClass = VALID.includes(o.class) ? o.class : "unclassified";
    const captured =
      o.captured && typeof o.captured === "object"
        ? {
            timing: o.captured.timing ? String(o.captured.timing) : undefined,
            referralTo: o.captured.referralTo ? String(o.captured.referralTo) : undefined,
          }
        : undefined;
    return {
      class: cls,
      confidence: typeof o.confidence === "number" ? Math.max(0, Math.min(1, o.confidence)) : 0.6,
      captured,
      reasoning: o.reasoning ? String(o.reasoning) : undefined,
    };
  } catch {
    return { class: "unclassified", confidence: 0, reasoning: "parse_error" };
  }
}
