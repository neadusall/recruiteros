/**
 * RecruiterOS · Texting Platform
 * Two-way conversation handler.
 *
 * On every inbound text it: classifies intent, decides whether to auto-reply
 * or escalate to a human, and (when appropriate) drafts the next message in
 * the recruiter's voice. This is what turns texting from blast into booking.
 */

import Anthropic from "@anthropic-ai/sdk";
import { classifyReply } from "../linkedin/classify";
import type { ClassifiedReply } from "../linkedin/types";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

const SYSTEM = `You are a recruiter's AI texting assistant. You write SMS replies to candidates and clients.
Rules:
- Plain text, SMS length (1 to 3 short sentences). No emojis, no links unless given.
- No em dashes or en dashes. Use commas or periods. Money in US dollars.
- Sound human, warm, and specific. Never robotic, never pushy.
- Goal: move toward a booked call. Answer the question, then propose a concrete next step.
- If the person asks to stop, do not draft a reply.`;

export interface ConversationContext {
  campaign?: string;      // e.g. "Senior React, Berlin"
  role?: string;          // role being discussed
  history: { from: "candidate" | "recruiter"; text: string }[];
}

export interface ConversationDecision {
  intent: ClassifiedReply["intent"];
  escalate: boolean;          // hand to a human now
  autoReply: string | null;   // draft to send, or null if escalate/stop
  reason: string;
}

export async function handleInbound(text: string, ctx: ConversationContext): Promise<ConversationDecision> {
  const classified = await classifyReply(text);

  // Stop or strong interest: do not let the bot keep talking.
  if (classified.intent === "stop") {
    return { intent: "stop", escalate: false, autoReply: null, reason: "Opt-out, suppress and stop." };
  }
  if (classified.escalate || classified.intent === "positive") {
    return {
      intent: classified.intent,
      escalate: true,
      autoReply: null,
      reason: "Hot, route to the recruiter with full context.",
    };
  }

  // Otherwise keep the conversation warm with a drafted reply.
  const transcript = ctx.history
    .map((m) => `${m.from === "candidate" ? "Them" : "You"}: ${m.text}`)
    .join("\n");

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 160,
    // cache_control is honored by the API but untyped in this SDK version.
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [
      {
        role: "user",
        content:
          `Campaign: ${ctx.campaign ?? "n/a"}. Role: ${ctx.role ?? "n/a"}.\n` +
          `Conversation so far:\n${transcript}\nThem: ${text}\n\n` +
          `Write the next SMS reply. Return only the message text.`,
      },
    ],
  });

  const block = res.content.find((b) => b.type === "text");
  const reply = block && block.type === "text" ? block.text.trim() : "";
  return {
    intent: classified.intent,
    escalate: false,
    autoReply: reply || null,
    reason: `Auto-reply (${classified.intent}).`,
  };
}
