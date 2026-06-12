/**
 * RecruiterOS · Voice Drops · Script templating
 *
 * A voicemail script is a template with merge slots, exactly like an email:
 *   "Hi {first_name}, this is {agent_name} with {agent_company}. I work with
 *    {role}s and wanted to reach out..."
 *
 * The rendered voicemail is synthesized one SENTENCE at a time (see
 * segmentScript): whole sentences keep a natural intonation contour, and each
 * sentence is cached by its exact text — so any repeated sentence (a shared
 * greeting for the same first name, or any variable-free line) is reused for free
 * and never re-synthesized (see clones.ts).
 *
 * The sweet spot for a landline voicemail is 15-25 seconds; this module
 * estimates duration and flags scripts that fall outside it.
 */

import type { VoicePersona } from "./types";

/** Slots the engine knows how to splice. */
export type Slot = "first_name" | "role" | "company" | "agent_name" | "agent_company";

const SLOT_RE = /\{(first_name|role|company|agent_name|agent_company)\}/g;

/** The 15-25s landline-voicemail sweet spot, in seconds. */
export const VM_MIN_SECONDS = 15;
export const VM_MAX_SECONDS = 25;

/** Average speaking rate (~150 wpm = 2.5 words/sec) for duration estimates. */
const WORDS_PER_SEC = 2.5;

/**
 * The two cloned-voice delivery channels have different ideal lengths:
 *  - amd       : a landline/VoIP voicemail drop — 15-25s (a quick, callable nudge)
 *  - voicenote : a LinkedIn voice note — 20-45s (a touch longer, more conversational)
 * The AI drafter targets the right window per channel, and validation flags a
 * script that lands outside it.
 */
export type VoiceChannel = "amd" | "voicenote";

export interface ChannelWindow {
  minSeconds: number;
  maxSeconds: number;
  /** Human label for prompts + UI copy. */
  label: string;
}

export const CHANNEL_WINDOWS: Record<VoiceChannel, ChannelWindow> = {
  amd: { minSeconds: VM_MIN_SECONDS, maxSeconds: VM_MAX_SECONDS, label: "landline voicemail (AMD)" },
  voicenote: { minSeconds: 20, maxSeconds: 45, label: "LinkedIn voice note" },
};

/** Approx spoken-word budget for a channel's window (at ~2.5 words/sec). */
export function wordBudget(channel: VoiceChannel): { min: number; max: number } {
  const w = CHANNEL_WINDOWS[channel];
  return { min: Math.round(w.minSeconds * WORDS_PER_SEC), max: Math.round(w.maxSeconds * WORDS_PER_SEC) };
}

export interface MergeVars {
  firstName?: string;
  role?: string;
  company?: string;
}

/** Fill a template's slots from the lead vars + the campaign persona. */
export function renderScript(template: string, vars: MergeVars, persona: VoicePersona): string {
  return template.replace(SLOT_RE, (_m, slot: Slot) => {
    switch (slot) {
      case "first_name": return vars.firstName?.trim() || "there";
      case "role": return vars.role?.trim() || "leader";
      case "company": return vars.company?.trim() || "your team";
      case "agent_name": return persona.agentName;
      case "agent_company": return persona.agentCompany;
      default: return "";
    }
  }).replace(/\s+/g, " ").trim();
}

/** Estimate spoken duration of a rendered line, in seconds. */
export function estimateSeconds(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.round((words / WORDS_PER_SEC) * 10) / 10;
}

export interface ScriptCheck {
  seconds: number;
  withinSweetSpot: boolean;
  /** True when the rendered text states the firm (honest identification). */
  identifies: boolean;
  warnings: string[];
}

/**
 * Validate a rendered voicemail for a given channel: must identify the firm and
 * should land in that channel's window (AMD 15-25s, LinkedIn voice note 20-45s).
 * Identification is REQUIRED — a drop that doesn't say who is calling is rejected
 * upstream (no anonymous/misleading drops).
 */
export function checkScriptFor(rendered: string, persona: VoicePersona, channel: VoiceChannel = "amd"): ScriptCheck {
  const seconds = estimateSeconds(rendered);
  const win = CHANNEL_WINDOWS[channel];
  const lower = rendered.toLowerCase();
  const identifies =
    lower.includes(persona.agentCompany.toLowerCase()) ||
    lower.includes(persona.agentName.toLowerCase());

  const warnings: string[] = [];
  if (!identifies) {
    warnings.push("Script must identify you or your firm by name — add {agent_name}/{agent_company}.");
  }
  if (seconds < win.minSeconds) warnings.push(`Too short (~${seconds}s); aim for ${win.minSeconds}-${win.maxSeconds}s for a ${win.label}.`);
  if (seconds > win.maxSeconds) warnings.push(`Too long (~${seconds}s); trim toward ${win.maxSeconds}s for a ${win.label}.`);

  return {
    seconds,
    withinSweetSpot: seconds >= win.minSeconds && seconds <= win.maxSeconds,
    identifies,
    warnings,
  };
}

/** AMD-channel validation (15-25s). Back-compat alias of checkScriptFor(..,"amd"). */
export function checkScript(rendered: string, persona: VoicePersona): ScriptCheck {
  return checkScriptFor(rendered, persona, "amd");
}

/**
 * The honest human-answer line: "This is {agent_name} with {agent_company} — is
 * this {first_name}?" Truthful self-identification, used when a person picks up
 * instead of a machine.
 */
export function identifierLine(persona: VoicePersona, firstName?: string): string {
  const who = firstName?.trim();
  const ask = who ? ` — is this ${who}?` : "";
  return `This is ${persona.agentName} with ${persona.agentCompany}${ask}`;
}

/**
 * Break a rendered voicemail into cacheable segments — ONE PER SENTENCE.
 *
 * We synthesize whole sentences, not isolated words: a TTS voice given a full
 * sentence produces a natural intonation contour, and the only seams are at
 * sentence boundaries (where a human pauses anyway). The earlier word-level split
 * (a name/role cut out mid-sentence) reset the prosody at every splice and sounded
 * robotic. Caching still works: each sentence's key is its full text, so a repeated
 * sentence — including "Hi Hector, this is Ryan…" for every other lead named
 * Hector, and every variable-free sentence — reuses its audio for free. Only a
 * sentence whose exact text is new is ever (re)synthesized.
 */
export interface ScriptSegment {
  /** Stable cache key (normalized text + hash) — identical text reuses the same audio. */
  key: string;
  /** The literal text to synthesize for this segment (a full sentence). */
  text: string;
  /** Kept for the cache-stats rollup; sentences are "static" (reused by exact text). */
  kind: "static" | "first_name" | "role" | "company";
}

/** Split rendered prose into sentences, keeping terminal punctuation. */
export function splitSentences(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const out: string[] = [];
  const re = /[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out.length ? out : [clean];
}

export function segmentScript(template: string, vars: MergeVars, persona: VoicePersona): ScriptSegment[] {
  // Fill every slot, then split on sentence boundaries so each whole sentence is
  // one cacheable, natural-sounding unit.
  const rendered = renderScript(template, vars, persona);
  return splitSentences(rendered).map((sentence) => ({
    key: cacheKey("vm", sentence),
    text: sentence,
    kind: "static" as const,
  }));
}

/** Tiny stable string hash (FNV-1a, base36) — disambiguates long, similar text. */
function hash36(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Normalize text into a stable, reuse-friendly cache key. A readable slug PLUS a
 * hash of the full text, so two long sentences that share a 48-char prefix never
 * collide onto the same cached audio.
 */
export function cacheKey(kind: string, text: string): string {
  const full = text.toLowerCase().replace(/\s+/g, " ").trim();
  const slug = full.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${kind}:${slug}-${hash36(full)}`;
}
