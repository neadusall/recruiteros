/**
 * RecruiterOS · Voice Drops · AI script drafter
 *
 * The voicemail script the operator types is only an EXAMPLE. In practice the
 * script is customized per lead by an LLM that follows a fixed set of parameters
 * so every cloned-voice message comes off natural and compliant:
 *
 *  - Length is bounded by the delivery channel:
 *      · AMD landline voicemail   → 15-25 seconds
 *      · LinkedIn voice note       → 20-45 seconds
 *  - It MUST identify the caller (real name + real firm) — no anonymous drops.
 *  - It is formatted for a one-sentence-at-a-time TTS engine (terminal
 *    punctuation per sentence, short sentences, contractions, spelled-out
 *    numbers, no em-dashes, "V.P." not "VP").
 *  - It never invents social proof ("X referred you", "I heard you're hiring").
 *
 * Two output modes:
 *  - templated: keep {first_name}/{role}/{company} merge slots so the result is a
 *    reusable library script (the slots splice in at send time, preserving the
 *    sentence-cache reuse).
 *  - rendered: a finished, lead-specific script with the real name/role spliced
 *    in — used when customizing a single drop at send time.
 *
 * Dry-run safe: with no ANTHROPIC_API_KEY it returns the seed/example unchanged
 * and flags dryRun, so nothing breaks before the key is connected.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { VoicePersona } from "./types";
import {
  CHANNEL_WINDOWS, wordBudget, renderScript, checkScriptFor, estimateSeconds,
  type VoiceChannel, type MergeVars,
} from "./script";

const MODEL = process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

/** Fixed speech-formatting + compliance rules every voice script must obey. */
const SYSTEM = `You write short scripts that are SPOKEN by a cloned human voice for recruiter outreach — either a landline voicemail (AMD) or a LinkedIn voice note. The text is fed to a text-to-speech engine ONE SENTENCE AT A TIME, so prosody comes entirely from punctuation. Write for the ear, not the eye.

HARD RULES (never break):
- The script MUST identify the caller by their real name and firm. Anonymous or misleading messages are forbidden.
- NEVER invent social proof or pretext. Do not say someone referred them, that you "heard they're hiring", or anything you were not told is true. Earn the call on real, specific substance only.
- End EVERY sentence with terminal punctuation (. ? !). Keep sentences short — one idea each.
- Use commas for phrase grouping and the vocative ("Thanks, {first_name}.").
- Use "..." for at most ONE deliberate pause (e.g. after the opener). Do not sprinkle it.
- NO em dashes or en dashes. Break into short sentences or use commas.
- Spell out numbers in words ("six to ten", "two years"). No digits. No phone numbers.
- Write ambiguous initialisms with periods so they are spoken as letters: "V.P." not "VP".
- Keep natural contractions ("it's", "won't", "he's"). No ALL-CAPS, no parentheses, no semicolons, no emojis, no hashtags, no links.
- US dollars with a $ sign if money is mentioned.
- Warm, specific, human, never salesy.

PACING MODEL — match this rhythm exactly (it is tuned for the TTS engine; copy the punctuation pattern, not the words):
"Hi {first_name}... this is {agent_name}, with {agent_company}. I came across your {role} search, and wanted to reach out. We help teams hire faster. If it's useful, give me a call back, at this number. Thanks {first_name}."
Notice the rhythm to reproduce:
- One held beat ("...") right after the name in the opener, then never again.
- A vocative comma around the recipient's name and a comma before "with {firm}" so the intro doesn't rush.
- Each idea is its own short sentence ending in a period, so the voice breathes between them.
- A comma right before the call-back / phone line to slow the delivery on the ask.
- Plain, warm spoken phrasing with contractions — it should sound like a person leaving a voicemail, not reading a paragraph.

Return STRICT JSON only: {"text": string}. No prose outside the JSON.`;

export interface DraftVoiceInput {
  channel: VoiceChannel;
  persona: VoicePersona;
  /** Sample/real merge values used to render + length-check (and, in rendered mode, to personalize). */
  vars?: MergeVars;
  /** An example script or talking points to take direction from (optional). */
  seed?: string;
  /** Extra real context to weave in — a hiring signal, the value prop, role detail. */
  context?: string;
  /** Keep {first_name}/{role}/{company} slots in the output (reusable template). Default true. */
  templated?: boolean;
}

export interface DraftVoiceResult {
  /** The customized script — a {slot} template when templated, else fully rendered. */
  text: string;
  /** Estimated spoken seconds of the rendered text. */
  seconds: number;
  channel: VoiceChannel;
  withinWindow: boolean;
  identifies: boolean;
  warnings: string[];
  /** Model used, or null on dry-run. */
  model: string | null;
  /** True when no LLM key — text is the seed/example unchanged. */
  dryRun: boolean;
}

function brief(input: DraftVoiceInput): string {
  const v = input.vars ?? {};
  const lines = [
    `Caller name (state this): ${input.persona.agentName}`,
    `Caller firm (state this): ${input.persona.agentCompany}`,
    input.templated === false ? `Recipient first name: ${v.firstName || "there"}` : null,
    input.templated === false && v.role ? `Recipient role: ${v.role}` : null,
    input.templated === false && v.company ? `Recipient company: ${v.company}` : null,
    input.context ? `Real context to use (do not exaggerate): ${input.context}` : null,
    input.seed ? `Example to take direction from (rewrite, do not copy verbatim):\n${input.seed}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

function slotRule(templated: boolean): string {
  return templated
    ? `Output a REUSABLE TEMPLATE: use the literal merge slots {first_name}, {role}, and {company} where the recipient's details go (they splice in at send time). Include {agent_name} and {agent_company} if you prefer slots for the caller. Keep the slots intact.`
    : `Output a FINISHED script for this one recipient with their real name and role written in. Do NOT leave any {curly} slots.`;
}

function safeText(s: string): string {
  try {
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a < 0 || b < a) return "";
    const obj = JSON.parse(s.slice(a, b + 1));
    return String(obj?.text ?? "").trim();
  } catch {
    return "";
  }
}

/** Render to plain prose for the length check (fills slots with sample values). */
function rendered(text: string, input: DraftVoiceInput): string {
  return renderScript(text, input.vars ?? { firstName: "Alex", role: "VP of Sales", company: "Acme" }, input.persona);
}

/**
 * Customize a voice script with the LLM, enforcing the channel's length window
 * and the speech-formatting + compliance rules. Does at most one corrective
 * re-ask when the first draft lands outside the window.
 */
export async function draftVoiceScript(input: DraftVoiceInput): Promise<DraftVoiceResult> {
  const channel = input.channel;
  const win = CHANNEL_WINDOWS[channel];
  const templated = input.templated !== false;

  // Dry-run: no key → hand back the seed/example as-is so the UI still works.
  if (!process.env.ANTHROPIC_API_KEY) {
    const text = (input.seed || "").trim();
    const chk = checkScriptFor(rendered(text, input), input.persona, channel);
    return {
      text, seconds: chk.seconds, channel, withinWindow: chk.withinSweetSpot,
      identifies: chk.identifies,
      warnings: text ? chk.warnings : ["Connect an Anthropic API key to let the AI customize scripts."],
      model: null, dryRun: true,
    };
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const wb = wordBudget(channel);
  const ask = (extra?: string) =>
    `Write a ${win.label} script that runs ${win.minSeconds} to ${win.maxSeconds} seconds when spoken aloud ` +
    `(roughly ${wb.min} to ${wb.max} words). ${slotRule(templated)}\n\n${brief(input)}` +
    (extra ? `\n\n${extra}` : "");

  async function generate(extra?: string): Promise<string> {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] as any,
      messages: [{ role: "user", content: ask(extra) }],
    });
    const block = res.content.find((b) => b.type === "text");
    return block && block.type === "text" ? safeText(block.text) : "";
  }

  let text = await generate();
  let chk = checkScriptFor(rendered(text, input), input.persona, channel);

  // One corrective pass if it landed outside the window.
  if (text && !chk.withinSweetSpot) {
    const dir = chk.seconds > win.maxSeconds
      ? `Your draft runs about ${chk.seconds} seconds, which is too long. Tighten it to ${win.minSeconds}-${win.maxSeconds} seconds (about ${wb.min}-${wb.max} words). Keep the same intent and all hard rules.`
      : `Your draft runs about ${chk.seconds} seconds, which is too short. Add one or two specific sentences to reach ${win.minSeconds}-${win.maxSeconds} seconds (about ${wb.min}-${wb.max} words). Keep all hard rules.`;
    const retry = await generate(dir);
    if (retry) {
      const rchk = checkScriptFor(rendered(retry, input), input.persona, channel);
      // Take the retry if it's closer to the window.
      if (rchk.withinSweetSpot || Math.abs(rchk.seconds - (win.minSeconds + win.maxSeconds) / 2) < Math.abs(chk.seconds - (win.minSeconds + win.maxSeconds) / 2)) {
        text = retry; chk = rchk;
      }
    }
  }

  return {
    text: text || (input.seed || "").trim(),
    seconds: chk.seconds,
    channel,
    withinWindow: chk.withinSweetSpot,
    identifies: chk.identifies,
    warnings: chk.warnings,
    model: MODEL,
    dryRun: false,
  };
}
