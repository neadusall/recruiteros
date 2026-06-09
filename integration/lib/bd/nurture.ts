/**
 * RecruiterOS · BD · 6-month nurture drip
 *
 * Everyone we reach in the initial four-channel BD push is enrolled here so they
 * keep getting relevant, industry-driven value touches from the operator over ~26
 * weeks — never a re-pitch, always a peer-level insight, a thoughtful comment on
 * their post, or a short voice note. Two jobs:
 *   1. RELATIONSHIP: deliver ~9 grounded value touches across email / LinkedIn
 *      comment / LinkedIn voice note, paced over six months.
 *   2. DE-DUPE LEDGER: a prospect enrolled here is never re-pulled by the enroll
 *      queue, so we never double-outreach the same person with the same message.
 *
 * Durable like the other stores (SNAP_KEY "bd_nurture"): persists when a DB / file
 * volume is configured, in-memory otherwise.
 */

import Anthropic from "@anthropic-ai/sdk";
import { nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

export type NurtureChannel = "email" | "linkedin_comment" | "linkedin_voice_note";

export interface NurtureTouch {
  /** Weeks after enrollment this touch becomes due. */
  week: number;
  channel: NurtureChannel;
  /** What this touch should accomplish — value, never a pitch. */
  intent: string;
}

/**
 * The 6-month plan: ~9 value touches, mixed channels, rising familiarity. Personal
 * touches from the operator; every one is generated fresh against the lead's role,
 * industry, and background so it stays relevant over the whole window.
 */
export const NURTURE_PLAN: NurtureTouch[] = [
  { week: 2,  channel: "linkedin_comment",    intent: "React to something they recently posted, or a public development in their sector, adding one genuinely useful insight. No ask." },
  { week: 4,  channel: "email",               intent: "Share one relevant industry trend or data point tied to their role's current pressures. End on a question, never a pitch." },
  { week: 7,  channel: "linkedin_voice_note", intent: "A warm, peer-level check-in referencing a real shift in their world. 20-35s, spoken aloud, human." },
  { week: 10, channel: "email",               intent: "Offer a useful perspective on a challenge their function is likely facing this quarter." },
  { week: 13, channel: "linkedin_comment",    intent: "Engage thoughtfully on their content or a sector development; reinforce that you genuinely follow their space." },
  { week: 16, channel: "email",               intent: "A forward-looking observation about where their industry is heading and what it means for their role." },
  { week: 19, channel: "linkedin_voice_note", intent: "A short, human voice note acknowledging the season/cycle in their business; offer one idea, no ask." },
  { week: 22, channel: "email",               intent: "A concise, valuable resource or framing relevant to their exact function. Still no pitch." },
  { week: 26, channel: "email",               intent: "A natural re-open: reflect on the past months in their market and invite an easy reply." },
];

/** Frozen lead context so every touch stays grounded without re-deriving it. */
export interface NurtureLead {
  firstName?: string;
  fullName?: string;
  title?: string;
  company?: string;
  industry?: string;
  persona?: string;
  profileSummary?: string;
  email?: string;
  linkedinUrl?: string;
  providerProfileId?: string;
  /** Unipile account to send LinkedIn nurture touches from (falls back to env). */
  linkedinAccountId?: string;
}

export type NurtureStatus = "active" | "needs_review" | "paused" | "completed";

/** A LinkedIn touch generated but not yet sent (the comment/voice-note send path is
 *  account-scoped + needs the post target, so the cron stages it for execution). */
export interface PendingTouch {
  channel: NurtureChannel;
  week: number;
  subject?: string;
  body: string;
  audioUrl?: string;
  generatedAt: string;
}

export interface NurtureEnrollment {
  prospectId: string;
  workspaceId: string;
  status: NurtureStatus;
  /** Why it is held (e.g. "low_confidence") when status is needs_review. */
  hold?: string;
  enrolledAt: string;
  /** Index into NURTURE_PLAN of the next touch to fire. */
  nextTouchIndex: number;
  /** When that touch becomes due (ISO). */
  nextDueAt: string;
  lead: NurtureLead;
  touchesSent: number;
  lastTouchAt?: string;
  /** Generated-but-unsent LinkedIn touches awaiting the send wiring. */
  pending: PendingTouch[];
}

const store = { enrollments: [] as NurtureEnrollment[] };
const SNAP_KEY = "bd_nurture";
function hydrate(s: any) {
  if (s?.enrollments) store.enrollments = s.enrollments;
}
const persist = debouncedSaver(SNAP_KEY, () => store);

let hydrated: Promise<void> | null = null;
export function ensureNurtureReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled() ? loadSnapshot<any>(SNAP_KEY).then(hydrate).catch(() => {}) : Promise.resolve();
  }
  return hydrated;
}
void ensureNurtureReady();

function weeksMs(w: number): number {
  return w * 7 * 24 * 60 * 60 * 1000;
}

/* ---------------- enrollment (also the de-dupe ledger) ---------------- */

export function isEnrolled(prospectId: string): boolean {
  return store.enrollments.some((e) => e.prospectId === prospectId);
}

export function getEnrollment(prospectId: string): NurtureEnrollment | undefined {
  return store.enrollments.find((e) => e.prospectId === prospectId);
}

export function listEnrollments(workspaceId?: string): NurtureEnrollment[] {
  return store.enrollments.filter((e) => !workspaceId || e.workspaceId === workspaceId);
}

/** Enroll a reached prospect into the 6-month drip. Idempotent on prospectId.
 *  `status` lets the queue hold low-confidence leads ("needs_review") for review. */
export function enroll(
  workspaceId: string,
  prospectId: string,
  lead: NurtureLead,
  opts: { status?: NurtureStatus; hold?: string } = {},
): NurtureEnrollment {
  const existing = getEnrollment(prospectId);
  if (existing) return existing;
  const now = nowIso();
  const first = NURTURE_PLAN[0];
  const e: NurtureEnrollment = {
    prospectId,
    workspaceId,
    status: opts.status ?? "active",
    hold: opts.hold,
    enrolledAt: now,
    nextTouchIndex: 0,
    nextDueAt: new Date(Date.parse(now) + weeksMs(first.week)).toISOString(),
    lead,
    touchesSent: 0,
    pending: [],
  };
  store.enrollments.push(e);
  persist();
  return e;
}

export function setStatus(prospectId: string, status: NurtureStatus): void {
  const e = getEnrollment(prospectId);
  if (!e) return;
  e.status = status;
  persist();
}

/** Stop nurturing someone who replied / opted out (call from the response pipeline or Flow D). */
export function pause(prospectId: string): void {
  setStatus(prospectId, "paused");
}

/* ---------------- scheduling ---------------- */

export interface DueTouch {
  enrollment: NurtureEnrollment;
  touch: NurtureTouch;
}

/** Active enrollments whose next touch is due at `at`. */
export function dueTouches(at: Date = new Date()): DueTouch[] {
  return store.enrollments
    .filter((e) => e.status === "active" && e.nextTouchIndex < NURTURE_PLAN.length && Date.parse(e.nextDueAt) <= at.getTime())
    .map((e) => ({ enrollment: e, touch: NURTURE_PLAN[e.nextTouchIndex] }));
}

/** Advance an enrollment after its current touch fires (or is staged). Schedules
 *  the next due touch from the ENROLLMENT date (fixed cadence), or completes. */
export function advance(prospectId: string, at: Date = new Date()): void {
  const e = getEnrollment(prospectId);
  if (!e) return;
  e.touchesSent += 1;
  e.lastTouchAt = at.toISOString();
  e.nextTouchIndex += 1;
  if (e.nextTouchIndex >= NURTURE_PLAN.length) {
    e.status = "completed";
  } else {
    const next = NURTURE_PLAN[e.nextTouchIndex];
    e.nextDueAt = new Date(Date.parse(e.enrolledAt) + weeksMs(next.week)).toISOString();
  }
  persist();
}

export function addPending(prospectId: string, p: PendingTouch): void {
  const e = getEnrollment(prospectId);
  if (!e) return;
  e.pending.push(p);
  persist();
}

/* ---------------- content generation ---------------- */

export interface NurtureContent {
  channel: NurtureChannel;
  /** email -> subject + body; linkedin_comment / voice_note -> body only. */
  subject?: string;
  body: string;
}

const NURTURE_SYSTEM = `You write a single follow-up nurture touch from a recruiting and talent advisory professional (Ryan / Lume) to an executive already in a long-term, relationship-building sequence. This is NOT a pitch and NOT a sales message. It is a peer-level, value-first touch that keeps a real relationship warm.

Rules:
- Sound like an industry peer and advisor who genuinely follows their space; never a recruiter, staffing agency, or salesperson.
- Be specific to their EXACT role and industry. Speak their language, metrics, and current pressures. Generalize to any title or sector with real depth; never sound like a template.
- Deliver one genuinely useful idea, observation, or acknowledgement. Never ask for a meeting or for business.
- Ground only in the real context provided. Never invent facts, posts, numbers, events, or client outcomes.
- Plain text. No emojis, no hashtags, no em dashes or en dashes, no links unless provided.
- Channel limits:
  - email: 60-110 words, with a quiet, peer-level subject line (never a pitch).
  - linkedin_comment: <= 300 characters, reads as a natural, thoughtful comment a peer would leave on their content.
  - linkedin_voice_note: a 20-35 second spoken script (~50-90 words), warm and conversational, written to be heard.`;

/** Generate one nurture touch's content, grounded in the frozen lead context. */
export async function generateNurtureTouch(lead: NurtureLead, touch: NurtureTouch): Promise<NurtureContent> {
  const brief = [
    lead.fullName ? `Name: ${lead.fullName}` : null,
    lead.title ? `Title: ${lead.title}` : null,
    lead.company ? `Company: ${lead.company}` : null,
    lead.industry ? `Industry: ${lead.industry}` : null,
    lead.persona ? `Persona: ${lead.persona}` : null,
    lead.profileSummary ? `Their background (REAL, ground a specific reference in this): ${lead.profileSummary}` : null,
  ].filter(Boolean).join("\n");

  const shape = touch.channel === "email" ? `{ "subject": string, "body": string }` : `{ "body": string }`;
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: [{ type: "text", text: NURTURE_SYSTEM, cache_control: { type: "ephemeral" } }] as any,
    messages: [
      {
        role: "user",
        content: `Channel: ${touch.channel}\nTouch intent: ${touch.intent}\n\nLEAD:\n${brief}\n\nRespond as strict JSON ${shape} and nothing else.`,
      },
    ],
  });

  const raw = resp.content.find((b) => b.type === "text");
  const text = raw && raw.type === "text" ? raw.text : "{}";
  let o: Record<string, unknown> = {};
  try {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s >= 0) o = JSON.parse(text.slice(s, e + 1));
  } catch {
    /* leave empty -> body "" */
  }
  return {
    channel: touch.channel,
    subject: typeof o.subject === "string" ? o.subject.trim() : undefined,
    body: typeof o.body === "string" ? o.body.trim() : "",
  };
}
