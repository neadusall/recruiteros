/**
 * RecruiterOS · LinkedIn Engine
 * AI classification of inbound replies.
 *
 * Mirrors the Response inbox auto-classification: every reply is sorted by
 * intent so the engine knows whether to pause, escalate, or keep nurturing.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ClassifiedReply, ReplyIntent } from "./types";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

const SYSTEM = `You classify inbound LinkedIn replies to recruiter outreach. Return strict JSON only.
Intents:
- positive: clear interest or wants to talk / book a call.
- soft_yes: open but hedged, asking for details (comp, stack, more info).
- timing_objection: interested later, not now ("after summer", "Q3").
- fit_objection: not the right role / not looking / happy where they are.
- referral: points you to someone else.
- not_interested: a clear no without hostility.
- stop: asks to stop / unsubscribe / do not contact. Always escalate=false but mark stop.
escalate = true when a human should take over now (positive or soft_yes or referral).`;

/** Heuristic fast-path for the obvious cases (saves a model call). */
function fastPath(text: string): ClassifiedReply | null {
  const t = text.toLowerCase();
  if (/\b(stop|unsubscribe|do not contact|remove me|opt out)\b/.test(t)) {
    return { intent: "stop", confidence: 0.99, escalate: false, suggestion: "Honor opt-out immediately and suppress." };
  }
  return null;
}

export async function classifyReply(text: string): Promise<ClassifiedReply> {
  const fast = fastPath(text);
  if (fast) return fast;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    // cache_control is honored by the API but untyped in this SDK version.
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [
      {
        role: "user",
        content:
          `Reply to classify:\n"""${text}"""\n\n` +
          `Respond as JSON: {"intent": string, "confidence": number, "escalate": boolean, "suggestion": string}.`,
      },
    ],
  });

  const block = response.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text : "{}";
  return normalize(raw);
}

function normalize(s: string): ClassifiedReply {
  const valid: ReplyIntent[] = [
    "positive", "soft_yes", "timing_objection", "fit_objection",
    "referral", "not_interested", "stop",
  ];
  try {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    const o = JSON.parse(s.slice(start, end + 1));
    const intent: ReplyIntent = valid.includes(o.intent) ? o.intent : "fit_objection";
    return {
      intent,
      confidence: typeof o.confidence === "number" ? Math.max(0, Math.min(1, o.confidence)) : 0.6,
      escalate: Boolean(o.escalate) && intent !== "stop",
      suggestion: String(o.suggestion ?? ""),
    };
  } catch {
    return { intent: "fit_objection", confidence: 0.4, escalate: false, suggestion: "Could not parse; review manually." };
  }
}
