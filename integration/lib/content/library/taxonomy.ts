/**
 * RecruiterOS · Parameterized Content Library — Taxonomy & Contract
 *
 * The "content pool" the engine pulls from the instant a lead is enriched. Unlike
 * the runtime LLM drafter (lib/bd/personaMessaging.ts), this library is authored
 * up front and renders deterministically in microseconds — no API call, no spend,
 * on the send path. The richness lives in the fragment packs (industries.ts,
 * functions.ts, signals.ts, tone.ts); the touch templates (templates.ts) compose
 * those fragments into ready-to-send, multi-channel messages.
 *
 * Selection key:  industry × function × seniority × signal × channel/touch.
 * Fallback chain guarantees a rich message for ANY title/signal/industry: an
 * unknown industry falls back to "general", an unknown function to "other", an
 * unknown signal to a generic timing angle. Nothing ever renders empty.
 *
 * House style for every fragment authored against these types:
 *  - Plain text. No emojis, no hashtags, no links.
 *  - Never fabricate a statistic, client name, or outcome. Any number is a
 *    {placeholder} the drafter/approver fills, never a hard-coded figure.
 *  - Speak the reader's native vocabulary; sound like an insider, not a vendor.
 */

import type { JobFunction, Seniority } from "../../signals/filters";
import type { SignalType } from "../../signals/types";

export type { JobFunction, Seniority, SignalType };

/** Coarse industry keys — mirror lib/signals/filters INDUSTRY_KEYWORDS, plus a
 *  universal "general" fallback that is always populated. */
export type IndustryKey =
  | "healthcare"
  | "fintech"
  | "saas"
  | "ecommerce"
  | "ai_ml"
  | "cybersecurity"
  | "edtech"
  | "logistics"
  | "gaming"
  | "climate"
  | "general";

export const INDUSTRY_KEYS: IndustryKey[] = [
  "healthcare", "fintech", "saas", "ecommerce", "ai_ml",
  "cybersecurity", "edtech", "logistics", "gaming", "climate", "general",
];

export const FUNCTION_KEYS: JobFunction[] = [
  "engineering", "product", "design", "data", "sales", "marketing",
  "finance", "operations", "people_hr", "customer_success", "legal",
  "executive", "other",
];

export const SENIORITY_KEYS: Seniority[] = [
  "intern", "junior", "mid", "senior", "lead", "manager",
  "director", "vp", "c_level", "founder",
];

/** Campaign-side motion (matches lib/core Motion, NOT the signals-engine Motion). */
export type Motion = "bd" | "recruiting";

/* ------------------------------------------------------------------ */
/* Fragment packs                                                      */
/* ------------------------------------------------------------------ */

/** What a buyer/candidate in a sector lives inside. The most voluminous pack. */
export interface IndustryPack {
  key: IndustryKey;
  label: string;
  /** One evergreen sentence on the forces shaping this sector right now. */
  context: string;
  /** Concrete operating pains a leader in this sector feels (4-7). */
  painPoints: string[];
  /** BD value angles that resonate — how our help is framed (4-7). */
  valueAngles: string[];
  /** Credible proof framings, templated with {placeholders}; never a hard stat (3-5). */
  proofPoints: string[];
  /** Native vocabulary/metrics so copy reads insider (6-10 terms). */
  vocabulary: string[];
  /** Recruiting motion: why a candidate in this sector should engage (3-5). */
  recruitingPitch: string[];
}

/** What a job FUNCTION owns and fears, independent of sector. */
export interface FunctionPack {
  key: JobFunction;
  label: string;
  /** Outcomes / KPIs this function is measured on (4-6). */
  caresAbout: string[];
  /** Role-specific operating pains (4-6). */
  painPoints: string[];
  /** Opening hooks/angles for BD outreach to this function (4-6). */
  hooks: string[];
  /** Recruiting: what attracts this function as a candidate (3-5). */
  recruitingAngle: string[];
  /** Likely objections to preempt (3-5). */
  objections: string[];
}

/** How to reference a specific hiring/buying signal as the reason for reaching out. */
export interface SignalAngle {
  type: SignalType;
  /** Why this signal means now is the moment (one sentence). */
  timing: string;
  /** BD opener referencing the signal; may use {placeholders}. */
  bd: string;
  /** Recruiting opener referencing the signal; may use {placeholders}. */
  recruiting: string;
}

/** Register + CTA discipline per seniority tier. */
export interface SeniorityTone {
  key: Seniority;
  /** Voice + register guidance (used to pick CTA + envelope, and as drafter hint). */
  tone: string;
  /** Preferred CTA phrasing for this level. */
  cta: string;
  /** Length discipline note. */
  brevity: string;
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

export type TouchChannel = "email" | "linkedin" | "voice" | "sms";
export type LinkedInAction = "connect" | "message" | "inmail" | "voice_note";

/**
 * A composable touch. `subject`/`body` carry SLOT TOKENS the resolver fills from
 * the selected packs + the prospect's merge fields. Tokens:
 *   {{first_name}} {{full_name}} {{company}} {{title}} {{role}} {{industry}}
 *   {{signal_opener}} {{industry_context}} {{industry_pain}} {{industry_value}}
 *   {{function_pain}} {{function_hook}} {{cares_about}} {{proof}} {{vocab}} {{cta}}
 *   {{sender}} {{calendar_link}} {{callback_number}}
 * Unknown/empty tokens are dropped cleanly (no dangling punctuation).
 */
export interface TouchTemplate {
  id: string;
  channel: TouchChannel;
  /** Days after enrollment (0 = day of). */
  day: number;
  name: string;
  /** LinkedIn step kind. */
  action?: LinkedInAction;
  /** Email only. */
  subject?: string;
  /** Rendered message body / spoken script (all channels). */
  body: string;
  /** Only emitted when warmth >= the campaign voice threshold. */
  hotOnly?: boolean;
  /** Hard envelope the resolver clamps to (chars for text, ~words for spoken). */
  maxChars?: number;
  /** Which motions this touch belongs to (default: both). */
  motions?: Motion[];
}

/* ------------------------------------------------------------------ */
/* Query + result                                                      */
/* ------------------------------------------------------------------ */

/** The pull parameters. Any field may be omitted; the resolver fills via the
 *  fallback chain and the prospect's own data. */
export interface ContentQuery {
  function?: JobFunction;
  seniority?: Seniority;
  industry?: IndustryKey | (string & {});
  signal?: SignalType;
  motion?: Motion;
  warmth?: number;
  voiceThreshold?: number;
  /** Merge fields for rendering. */
  prospect?: {
    firstName?: string;
    fullName?: string;
    company?: string;
    title?: string;
    location?: string;
    headline?: string;
  };
  sender?: string;
  calendarLink?: string;
  callbackNumber?: string;
}

/** One rendered, ready-to-send touch. */
export interface CraftedTouch {
  id: string;
  channel: TouchChannel;
  action?: LinkedInAction;
  day: number;
  name: string;
  subject?: string;
  body: string;
  hotOnly?: boolean;
}

/** The full pull result for a lead. */
export interface CraftedSequence {
  /** Resolved selection (echoed back for transparency + debugging). */
  resolved: {
    function: JobFunction;
    seniority: Seniority;
    industry: IndustryKey;
    signal?: SignalType;
    motion: Motion;
    industryFallback: boolean;
    functionFallback: boolean;
    signalFallback: boolean;
  };
  touches: CraftedTouch[];
}
