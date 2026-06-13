/**
 * RecruitersOS · LinkedIn Engine
 * AI message generation, structured around the rapport-first ladder.
 *
 * Every generated touch is bound to a "rung" so the sequence physically cannot
 * pitch before rapport is built:
 *   recognize -> relate -> invite -> pitch -> release
 *
 * Uses the Anthropic API with prompt caching on the static system prompt to
 * keep per-message cost low at volume.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Prospect, SequenceStep } from "./types";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

/** Hard rules for the model, cached so we don't pay for it every call. */
const SYSTEM = `You write LinkedIn outreach for expert recruiters. Voice: warm, specific, human, never salesy. Hard rules:
- Plain text only. No emojis. No hashtags. No links unless explicitly provided.
- Never use em dashes or en dashes. Use commas or periods.
- All money in US dollars with a $ sign.
- Connection-request notes must be <= 280 characters.
- Messages must be 2 to 5 short sentences.
- Reference the prospect's real, specific details. Do not invent facts.
- Obey the RAPPORT RUNG. Only the "pitch" rung may make an explicit ask.
Rung definitions:
- recognize: genuine specific recognition of their work. No ask. No mention of a role.
- relate: a useful observation tied to their current signal. No ask.
- invite: ask permission to share something, not for their time. One soft, easy yes.
- pitch: now make the concrete offer with real details and one clear next step.
- release: gracious breakup that leaves value and keeps the door open.
- warmup: not a message; return an empty string.`;

export interface GeneratedMessage {
  rung: SequenceStep["rung"];
  /** For connect: the note. For inmail: the body. For message: the body. */
  text: string;
  /** Only present for InMail. */
  subject?: string;
}

function prospectBrief(p: Prospect): string {
  const c = p.context ?? {};
  const role = c.role
    ? `Role to pitch (only at pitch rung): ${c.role.title}` +
      (c.role.comp ? `, ${c.role.comp}` : "") +
      (c.role.remote ? ", remote" : "") +
      (c.role.stack?.length ? `, stack: ${c.role.stack.join(", ")}` : "")
    : "Role to pitch: (none provided)";
  return [
    `Name: ${p.fullName} (use first name: ${p.firstName})`,
    p.headline ? `Headline: ${p.headline}` : null,
    p.company ? `Company: ${p.company}` : null,
    p.location ? `Location: ${p.location}` : null,
    c.signal ? `Current signal: ${c.signal}` : null,
    c.recognition ? `Specific work to recognize: ${c.recognition}` : null,
    c.notes?.length ? `Notes: ${c.notes.join("; ")}` : null,
    role,
  ].filter(Boolean).join("\n");
}

/**
 * Generate the message for a given step + prospect. `warmup` rungs return "".
 * Honors a hand-written variant template when present (light touch-up only).
 */
export async function generateMessage(
  prospect: Prospect,
  step: SequenceStep,
  variantTemplate?: string,
): Promise<GeneratedMessage> {
  if (step.rung === "warmup" || step.action === "profile_view" || step.action === "endorse") {
    return { rung: step.rung, text: "" };
  }

  const wantsSubject = step.action === "inmail";
  const instruction = variantTemplate
    ? `Lightly adapt this approved template to the prospect without changing its intent. Keep it on the "${step.rung}" rung.\n\nTEMPLATE:\n${variantTemplate}`
    : `Write the "${step.rung}" rung touch for this prospect, delivered via LinkedIn ${step.action}.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    // cache_control is honored by the API but untyped in this SDK version.
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [
      {
        role: "user",
        content:
          `${instruction}\n\nPROSPECT:\n${prospectBrief(prospect)}\n\n` +
          `Respond as strict JSON: {${wantsSubject ? '"subject": string, ' : ""}"text": string}. No prose outside the JSON.`,
      },
    ],
  });

  const raw = response.content.find((b) => b.type === "text");
  const text = raw && raw.type === "text" ? raw.text : "{}";
  const parsed = safeJson(text);
  return {
    rung: step.rung,
    text: String(parsed.text ?? "").trim(),
    subject: wantsSubject ? String(parsed.subject ?? `Quick note, ${prospect.firstName}`) : undefined,
  };
}

function safeJson(s: string): { text?: string; subject?: string } {
  try {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    return start >= 0 ? JSON.parse(s.slice(start, end + 1)) : {};
  } catch {
    return {};
  }
}

/** Pick a variant by weight (deterministic-ish, jittered by index). */
export function pickVariant(step: SequenceStep): { id: string; template?: string } | undefined {
  if (!step.variants?.length) return undefined;
  const total = step.variants.reduce((s, v) => s + v.weight, 0);
  let r = Math.random() * total;
  for (const v of step.variants) {
    r -= v.weight;
    if (r <= 0) return { id: v.id, template: v.template };
  }
  const last = step.variants[step.variants.length - 1];
  return { id: last.id, template: last.template };
}
