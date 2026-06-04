/**
 * RecruiterOS · Voice Drops · Script templating
 *
 * A voicemail script is a template with merge slots, exactly like an email:
 *   "Hi {first_name}, this is {agent_name} with {agent_company}. I work with
 *    {role}s and wanted to reach out..."
 *
 * Only the variable slots ({first_name}, {role}, {company}) change per lead, so
 * the static prose is rendered ONCE per script+voice and the variable words are
 * cached and reused — that is what makes the clone-token cost go to zero after
 * the first time a given name/role is seen (see clones.ts).
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
 * Validate a rendered voicemail: must identify the firm and should land in the
 * 15-25s window. Identification is REQUIRED — a drop that doesn't say who is
 * calling is rejected upstream (no anonymous/misleading drops).
 */
export function checkScript(rendered: string, persona: VoicePersona): ScriptCheck {
  const seconds = estimateSeconds(rendered);
  const lower = rendered.toLowerCase();
  const identifies =
    lower.includes(persona.agentCompany.toLowerCase()) ||
    lower.includes(persona.agentName.toLowerCase());

  const warnings: string[] = [];
  if (!identifies) {
    warnings.push("Script must identify you or your firm by name — add {agent_name}/{agent_company}.");
  }
  if (seconds < VM_MIN_SECONDS) warnings.push(`Too short (~${seconds}s); aim for ${VM_MIN_SECONDS}-${VM_MAX_SECONDS}s.`);
  if (seconds > VM_MAX_SECONDS) warnings.push(`Too long (~${seconds}s); trim toward ${VM_MAX_SECONDS}s.`);

  return {
    seconds,
    withinSweetSpot: seconds >= VM_MIN_SECONDS && seconds <= VM_MAX_SECONDS,
    identifies,
    warnings,
  };
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
 * Break a rendered voicemail into the cacheable segments used by the clone
 * cache: the static lead-in (everything up to the first name), the per-name
 * snippet, the static middle, the per-role snippet, and the static tail. When a
 * template doesn't contain {first_name}/{role} the whole thing is one static
 * segment. Each segment carries a stable cache key so identical text (same name,
 * same role, same static prose) is only ever synthesized once.
 */
export interface ScriptSegment {
  /** Stable cache key (normalized text) — identical text reuses the same audio. */
  key: string;
  /** The literal text to synthesize for this segment. */
  text: string;
  /** Variable segments (name/role) are reused across leads; static aren't. */
  kind: "static" | "first_name" | "role" | "company";
}

export function segmentScript(template: string, vars: MergeVars, persona: VoicePersona): ScriptSegment[] {
  // Resolve agent_* slots first (they're constant for the campaign), then split
  // on the remaining lead-variable slots so each variable becomes its own
  // cacheable segment.
  const withAgent = template
    .replace(/\{agent_name\}/g, persona.agentName)
    .replace(/\{agent_company\}/g, persona.agentCompany);

  const parts = withAgent.split(/(\{first_name\}|\{role\}|\{company\})/g);
  const segments: ScriptSegment[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (part === "{first_name}") {
      const text = vars.firstName?.trim() || "there";
      segments.push({ key: cacheKey("name", text), text, kind: "first_name" });
    } else if (part === "{role}") {
      const text = vars.role?.trim() || "leader";
      segments.push({ key: cacheKey("role", text), text, kind: "role" });
    } else if (part === "{company}") {
      const text = vars.company?.trim() || "your team";
      segments.push({ key: cacheKey("company", text), text, kind: "company" });
    } else {
      const text = part.replace(/\s+/g, " ").trim();
      if (text) segments.push({ key: cacheKey("static", text), text, kind: "static" });
    }
  }
  return segments;
}

/** Normalize text into a stable, reuse-friendly cache key. */
export function cacheKey(kind: string, text: string): string {
  const norm = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `${kind}:${norm}`;
}
