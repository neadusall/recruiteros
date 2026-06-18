/**
 * RecruitersOS · BD · 6-month nurture drip
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
import type { Variant } from "./experiment";
import { assignStrategy, strategyFor, type Strategy } from "./nurtureStrategy";
import { sanitizeDashes } from "./sanitize";
import { HOUSE_VOICE, BD_POSITIONING } from "./houseVoice";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";

export type NurtureChannel = "email" | "linkedin_comment" | "linkedin_voice_note" | "ask_email" | "email_voice_wave";

export interface NurtureTouch {
  /** Weeks after enrollment this touch becomes due. */
  week: number;
  channel: NurtureChannel;
  /** What this touch should accomplish — value, never a pitch. */
  intent: string;
}

/**
 * APPROACH A — THE AUTHORITY ENGINE (24-month, content-led cadence).
 *
 * The cadence after the Day-0 opener (email + LinkedIn connect + voicemail). Make
 * Lume the industry-intelligence source the executive comes to rely on: a regular
 * ~2x/month value rhythm so we stay top-of-mind, with a quarterly personal touch,
 * settling into a sustainable cadence across two full years.
 *
 *   MONTH 1 — weekly reinforcement waves (weeks 1-4). Each wave is an email PAIRED
 *   with a voicemail drop to their direct line, or a LinkedIn voice note when we
 *   have no dialable number. Every wave opens a DIFFERENT door (a fresh angle), never
 *   "did you get my email". The blitz stops the instant they reply (halt/pause).
 *
 *   MONTHS 2-6 — establish authority: ~2 value touches/month, rotating email /
 *   LinkedIn comment / voice note, with one tactful earned ask at week 4.
 *
 *   MONTHS 7-18 — sustain: same ~2x/month rhythm + a quarterly personal touch.
 *
 *   MONTHS 19-24 — deepen: keep the rhythm and, as engagement warms, push toward a
 *   real conversation when signals align.
 *
 * Every touch is generated fresh against the lead's exact role, industry, and
 * background. A reply at any point halts everything and triggers the booking ask.
 * Signal triggers (job change, company news, a post) override this cadence — see
 * `queueTrigger` / `onJobChange`.
 */
export const AUTHORITY_PLAN: NurtureTouch[] = [
  // --- Month 1: weekly waves (email + voicemail, LinkedIn voice note fallback). Day 0
  //     is the opener (wave 1) from the initial funnel; these are waves 2, 3, 4. ---
  { week: 1, channel: "email_voice_wave", intent: "Wave 2: a fresh, specific angle on their situation, a DIFFERENT pressure or market point than the opener. Lead with value; mention only in passing that you also left a quick note. No ask." },
  { week: 2, channel: "email_voice_wave", intent: "Wave 3: a concrete example or option relevant to their open role or function. New value, not a continuation of the last one." },
  { week: 3, channel: "email_voice_wave", intent: "Wave 4: a forward looking thought on their market and why it matters now. Warm, still value first, an optional soft invitation to connect." },
  // --- Transition: the one tactful ask, after a month of value with no reply ---
  { week: 4, channel: "ask_email",        intent: "After a month of value with no reply, the single tactful, value framed ask for a short working call." },
  // --- Months 2-6: establish authority (lighter, ~2x/month) ---
  { week: 8,  channel: "linkedin_comment",    intent: "React to something they recently posted, or a sector development, adding one genuinely useful insight. No ask." },
  { week: 11, channel: "email",               intent: "Offer a useful perspective on a challenge their function is likely facing this quarter." },
  { week: 14, channel: "linkedin_voice_note", intent: "A warm, peer level check in referencing a real shift in their world. About 30 seconds, spoken aloud, human." },
  { week: 17, channel: "email",               intent: "A forward looking observation about where their industry is heading and what it means for their role." },
  { week: 20, channel: "linkedin_comment",    intent: "Engage thoughtfully on their content or a sector development; reinforce that you genuinely follow their space." },
  { week: 23, channel: "email",               intent: "A concise, valuable resource or framing relevant to their exact function. Still no pitch." },
  { week: 26, channel: "email",               intent: "A natural reconnect: reflect on the past six months in their market and invite an easy reply." },
  // --- Months 7-18: sustain. ~2 value touches/month, rotating email / LinkedIn
  //     comment / voice note, with a quarterly personal voice-note touch. ---
  { week: 30, channel: "email",               intent: "A specific data point or shift in their function's leadership market and what it means for how they should read their own leverage. No ask." },
  { week: 32, channel: "linkedin_comment",    intent: "A substantive comment on their recent content or a sector development; add a real point, never pitch." },
  { week: 36, channel: "email",               intent: "The comp-structure read: where the real movement is (equity, long-term incentives, bespoke packages) versus base. Useful regardless of intent." },
  { week: 39, channel: "linkedin_voice_note", intent: "Quarterly personal voice note: no agenda, flag one current trend hitting their industry's leaders this quarter and that you thought of them. About 30 seconds, spoken aloud." },
  { week: 43, channel: "email",               intent: "What boards now value (judgment, learning agility, adaptability over resume prestige) and how a leader in their seat should be positioning the way they think." },
  { week: 47, channel: "linkedin_comment",    intent: "Engage thoughtfully on their content or a notable move in their space; reinforce that you genuinely follow it." },
  { week: 52, channel: "email",               intent: "A one-year mark, year-in-review style read on where their function's leadership market went and where it is heading. Warm, an easy open door." },
  { week: 56, channel: "email",               intent: "The fastest-growing seats adjacent to their background (Chief Growth, Transformation, AI, CRO) and why they are being created around people like them." },
  { week: 60, channel: "linkedin_voice_note", intent: "Quarterly personal voice note: one genuinely useful, current observation about their market, no ask. About 30 seconds, spoken aloud." },
  { week: 64, channel: "email",               intent: "A forward look at the interim / fractional leadership rise and what it opens up for someone with their scope. No pitch." },
  { week: 68, channel: "linkedin_comment",    intent: "A real, additive comment on their content or a sector development." },
  { week: 72, channel: "email",               intent: "Mandate clarity: the most common place senior hires stumble is an under-defined mandate, and how the sharpest leaders fix it early. Useful framing, no ask." },
  // --- Months 19-24: deepen. Keep the rhythm; as engagement warms, move gently
  //     toward a real conversation when the signals align. ---
  { week: 78, channel: "linkedin_voice_note", intent: "Quarterly personal voice note, a touch warmer: reflect on having followed their market for a year and a half and offer one current, useful read. About 30 seconds." },
  { week: 84, channel: "email",               intent: "A specific, current market read for their function with a quiet, low-friction invitation to a confidential conversation about where they sit. Earned, not pushy." },
  { week: 90, channel: "linkedin_comment",    intent: "A substantive comment on their content or a notable development in their space." },
  { week: 96, channel: "email",               intent: "A forward read on their function's leadership market into the next year and why it matters specifically for someone in their position." },
  { week: 102, channel: "email",              intent: "The two-year reconnect: reflect on the relationship, one genuinely useful current read, and an easy, warm open door to talk if ever useful." },
];

/**
 * APPROACH B — THE INNER CIRCLE (trigger-led, 24-month).
 *
 * Be the personal, perfectly-timed advisor. Fewer SCHEDULED touches; the real
 * volume comes from SIGNAL triggers (job change, company news, a post they wrote)
 * routed through `queueTrigger` / `onJobChange`. This plan is just the light
 * QUARTERLY FLOOR so they never fully go cold between signals, plus an annual
 * personal-outlook touch. Far fewer total touches than Authority, each far more
 * personal. Best-suited to warmer, higher-value contacts.
 */
export const INNER_CIRCLE_PLAN: NurtureTouch[] = [
  { week: 13,  channel: "linkedin_voice_note", intent: "Quarterly floor (no signal): no news on your end, just thinking about where their industry is heading and they came to mind. One current, genuinely useful read. Warm, no ask. About 30 seconds, spoken aloud." },
  { week: 26,  channel: "email",               intent: "Quarterly floor: one specific, current observation about their function's market that is worth knowing, and a quiet open door. No ask." },
  { week: 39,  channel: "linkedin_voice_note", intent: "Quarterly floor: a short personal voice note with one useful current read on their world and that you thought of them. No agenda." },
  { week: 52,  channel: "email",               intent: "Annual personal outlook: a tailored read on what is coming for leaders in their function next year and why it matters specifically for someone in their position. High-trust, no ask." },
  { week: 65,  channel: "linkedin_voice_note", intent: "Quarterly floor: one genuinely useful current observation about their market, warm and human. No ask. About 30 seconds." },
  { week: 78,  channel: "email",               intent: "Quarterly floor: a specific, current piece worth their attention on their function's market, with a quiet invitation to a confidential conversation if ever useful." },
  { week: 91,  channel: "linkedin_voice_note", intent: "Quarterly floor: a short personal voice note with one useful read and a genuine, no-agenda check in." },
  { week: 104, channel: "email",               intent: "Annual personal outlook at the two-year mark: a tailored forward read for their function and a warm, easy open door to talk whenever it is useful." },
];

/** Which 24-month plan an enrollment runs, by its A/B strategy. */
export function planFor(strategy: Strategy): NurtureTouch[] {
  return strategy === "inner_circle" ? INNER_CIRCLE_PLAN : AUTHORITY_PLAN;
}

/** A rolling quarterly floor touch for DORMANT enrollments (past plan end, never
 *  engaged) so they keep getting a single useful read each quarter, nothing more. */
const QUARTER_WEEKS = 13;
const DORMANT_FLOOR: NurtureTouch = {
  week: 0,
  channel: "email",
  intent: "Quarterly floor for a long-quiet relationship. No news on your end; one genuinely useful, current observation relevant to their function, and a quiet open door. No ask, no pressure.",
};

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
  /** Direct line + fallback number for the weekly wave's voicemail drop. */
  landlinePhone?: string;
  phone?: string;
  /** Free-text location -> the voicemail engine resolves the calling-window timezone. */
  location?: string;
  linkedinUrl?: string;
  providerProfileId?: string;
  /** Unipile account to send LinkedIn nurture touches from (falls back to env). */
  linkedinAccountId?: string;
  /** A/B model this prospect is in, so nurture + the ask stay in the same model. */
  variant?: Variant;
}

/**
 * Lifecycle states. STOPPED in the spec maps to `paused` here (set by the response
 * pipeline / Flow D the instant someone replies or opts out) plus the prospect's own
 * `do_not_contact` status, which already halts every channel globally. `dormant` is
 * a soft state: an enrollment that ran its full ~24-month plan without ever engaging
 * drops to quarterly-floor-only (a single useful read per quarter) instead of ending.
 */
export type NurtureStatus = "active" | "needs_review" | "paused" | "completed" | "dormant";

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

/** A real-world signal about the prospect that OVERRIDES the scheduled cadence and
 *  fires an immediate, event-anchored touch (the highest-value moments in the system).
 *  Queued by the signal engine; drained first by the nurture tick. */
export interface TriggeredTouch {
  kind: "job_change" | "company_news" | "post" | "milestone";
  /** The genuine, specific detail to anchor the touch to (e.g. the new role/company,
   *  the funding round, what they posted). Never fabricated. */
  detail: string;
  queuedAt: string;
  actioned?: boolean;
}

export interface NurtureEnrollment {
  prospectId: string;
  workspaceId: string;
  status: NurtureStatus;
  /** A/B STRATEGY axis: which 24-month plan this prospect runs (authority vs inner
   *  circle). Orthogonal to lead.variant (mpc vs consultative message framing). */
  strategy: Strategy;
  /** Why it is held (e.g. "low_confidence") when status is needs_review. */
  hold?: string;
  enrolledAt: string;
  /** Index into this enrollment's plan (planFor(strategy)) of the next touch to fire. */
  nextTouchIndex: number;
  /** When that touch becomes due (ISO). */
  nextDueAt: string;
  lead: NurtureLead;
  touchesSent: number;
  /** Times the prospect has actually engaged (reply / positive). Drives DORMANT. */
  engagedCount?: number;
  lastTouchAt?: string;
  /** Generated-but-unsent LinkedIn touches awaiting the send wiring. */
  pending: PendingTouch[];
  /** Real-world signal touches that override the cadence; drained first each tick. */
  triggered: TriggeredTouch[];
}

const store = { enrollments: [] as NurtureEnrollment[] };
const SNAP_KEY = "bd_nurture";
function hydrate(s: any) {
  if (s?.enrollments) {
    // Backfill fields added after some enrollments were persisted (strategy axis,
    // trigger queue, engagement counter) so older records keep working.
    store.enrollments = (s.enrollments as NurtureEnrollment[]).map((e) => ({
      ...e,
      strategy: e.strategy ?? strategyFor(e.prospectId),
      triggered: e.triggered ?? [],
      engagedCount: e.engagedCount ?? 0,
    }));
  }
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

// Weekly waves vary the day-of-week and time-of-day so they never land on the
// same weekday/time twice (looks human, not automated). Weekends roll to Monday.
const WAVE_DAY_SHIFT = [0, 1, 3, 2];
const WAVE_HOUR = [10, 14, 16, 11];

/** When a touch at plan index `idx` becomes due. Waves get varied weekday + hour. */
function scheduleTouchAt(enrolledAt: string, touch: NurtureTouch, idx: number): string {
  const d = new Date(Date.parse(enrolledAt) + weeksMs(touch.week));
  if (touch.channel === "email_voice_wave") {
    d.setDate(d.getDate() + WAVE_DAY_SHIFT[idx % WAVE_DAY_SHIFT.length]);
    d.setHours(WAVE_HOUR[idx % WAVE_HOUR.length], (idx * 13) % 60, 0, 0);
    const dow = d.getDay();
    if (dow === 6) d.setDate(d.getDate() + 2); // Saturday -> Monday
    else if (dow === 0) d.setDate(d.getDate() + 1); // Sunday -> Monday
  }
  return d.toISOString();
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
  opts: { status?: NurtureStatus; hold?: string; strategy?: Strategy } = {},
): NurtureEnrollment {
  const existing = getEnrollment(prospectId);
  if (existing) return existing;
  const now = nowIso();
  // A/B strategy axis: pin (and remember) which 24-month plan this prospect runs.
  const strategy = opts.strategy ?? assignStrategy(prospectId);
  const plan = planFor(strategy);
  const first = plan[0];
  const e: NurtureEnrollment = {
    prospectId,
    workspaceId,
    status: opts.status ?? "active",
    strategy,
    hold: opts.hold,
    enrolledAt: now,
    nextTouchIndex: 0,
    nextDueAt: scheduleTouchAt(now, first, 0),
    lead,
    touchesSent: 0,
    engagedCount: 0,
    pending: [],
    triggered: [],
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

/* ---------------- triggered touches (signals override cadence) ---------------- */

/** Build the synthetic touch for a real-world trigger. Email for the moments that
 *  must land (job change, company news, milestone); a comment for a post. */
function triggerTouch(t: TriggeredTouch): NurtureTouch {
  switch (t.kind) {
    case "job_change":
      return {
        week: 0,
        channel: "email",
        intent: `Warm, no-ask congratulations on their recent move: ${t.detail}. Reference the genuine step up in scope. Offer one genuinely useful insight about the first 90 days in a role like this (the mandate is usually less defined than it looks; clarifying it early is the difference maker). Sound like a well connected friend, not a recruiter.`,
      };
    case "company_news":
      return {
        week: 0,
        channel: "email",
        intent: `Saw ${t.detail}. Lead with one specific, non-obvious insight about what it likely means for their function or role. No ask, just the read from where you sit in the market.`,
      };
    case "post":
      return {
        week: 0,
        channel: "linkedin_comment",
        intent: `Leave a genuine, substantive comment that advances the point they made: ${t.detail}. Add one real point, never pitch.`,
      };
    case "milestone":
    default:
      return {
        week: 0,
        channel: "email",
        intent: `Genuine, warm recognition of a real milestone: ${t.detail}. No ask, peer level.`,
      };
  }
}

/** Queue a real-world trigger for an enrolled prospect (job change, company news, a
 *  post, a milestone). Deduped against an identical unactioned trigger. A dormant or
 *  completed enrollment is re-woken to active so the relationship picks back up;
 *  paused / opted-out enrollments are left alone (the opt-out is absolute). */
export function queueTrigger(prospectId: string, t: Omit<TriggeredTouch, "queuedAt" | "actioned">): boolean {
  const e = getEnrollment(prospectId);
  if (!e || e.status === "paused") return false;
  const dup = e.triggered.some((x) => !x.actioned && x.kind === t.kind && x.detail === t.detail);
  if (dup) return true;
  e.triggered.push({ ...t, queuedAt: nowIso() });
  if (e.status === "dormant" || e.status === "completed") e.status = "active";
  persist();
  return true;
}

/** Mark the first unactioned trigger as fired (called after the tick dispatches it). */
export function dequeueTrigger(prospectId: string, at: Date = new Date()): void {
  const e = getEnrollment(prospectId);
  if (!e) return;
  const t = e.triggered.find((x) => !x.actioned);
  if (!t) return;
  t.actioned = true;
  e.touchesSent += 1;
  e.lastTouchAt = at.toISOString();
  persist();
}

/** Record that the prospect genuinely engaged (reply / positive). Keeps an enrollment
 *  off the DORMANT track at plan end. Idempotent-ish counter; safe to over-call. */
export function markEngaged(prospectId: string): void {
  const e = getEnrollment(prospectId);
  if (!e) return;
  e.engagedCount = (e.engagedCount ?? 0) + 1;
  persist();
}

/**
 * Job-change re-acquisition (the 2-year superpower). The signal engine detects the
 * move and re-acquires contact info; it hands the resolved new context here. We
 * re-segment the frozen lead to the new role and queue the immediate, no-ask
 * congratulations touch (the single highest-value moment in the system).
 * Returns false when the prospect is not enrolled (caller keeps default behavior).
 */
export function onJobChange(
  prospectId: string,
  change: { company?: string; title?: string; email?: string; companyDomain?: string; detail?: string },
): boolean {
  const e = getEnrollment(prospectId);
  if (!e || e.status === "paused") return false;
  if (change.company) e.lead.company = change.company;
  if (change.title) e.lead.title = change.title;
  if (change.email) e.lead.email = change.email;
  const detail =
    change.detail ||
    [change.title, change.company].filter(Boolean).join(" at ") ||
    "a recent role change";
  persist();
  return queueTrigger(prospectId, { kind: "job_change", detail });
}

/* ---------------- scheduling ---------------- */

export interface DueTouch {
  enrollment: NurtureEnrollment;
  touch: NurtureTouch;
  /** Set when this is a cadence-overriding triggered touch (not a plan rung). */
  trigger?: TriggeredTouch;
  /** Set when this is the rolling quarterly floor for a DORMANT enrollment. */
  dormantFloor?: boolean;
}

/** Touches due at `at`: triggered touches first (they override cadence), then the
 *  scheduled plan rung for active enrollments, then the quarterly floor for dormant
 *  ones. At most one touch per enrollment per tick. Opted-out (paused) skipped. */
export function dueTouches(at: Date = new Date()): DueTouch[] {
  const out: DueTouch[] = [];
  for (const e of store.enrollments) {
    if (e.status === "paused" || e.status === "needs_review" || e.status === "completed") continue;
    // 1) Signal triggers override the cadence (fire even for dormant enrollments).
    const trig = e.triggered.find((x) => !x.actioned);
    if (trig) {
      out.push({ enrollment: e, touch: triggerTouch(trig), trigger: trig });
      continue;
    }
    if (Date.parse(e.nextDueAt) > at.getTime()) continue;
    // 2) Active: the next scheduled rung of this enrollment's 24-month plan.
    if (e.status === "active") {
      const plan = planFor(e.strategy);
      if (e.nextTouchIndex < plan.length) out.push({ enrollment: e, touch: plan[e.nextTouchIndex] });
      continue;
    }
    // 3) Dormant: quarterly-floor only.
    if (e.status === "dormant") {
      out.push({ enrollment: e, touch: DORMANT_FLOOR, dormantFloor: true });
    }
  }
  return out;
}

/** Advance an enrollment after a scheduled plan rung fires (or is staged). Schedules
 *  the next due rung from the ENROLLMENT date (fixed cadence). At plan end, drops to
 *  DORMANT (quarterly-floor only) if the prospect never engaged, else COMPLETED. */
export function advance(prospectId: string, at: Date = new Date()): void {
  const e = getEnrollment(prospectId);
  if (!e) return;
  const plan = planFor(e.strategy);
  e.touchesSent += 1;
  e.lastTouchAt = at.toISOString();
  e.nextTouchIndex += 1;
  if (e.nextTouchIndex >= plan.length) {
    if ((e.engagedCount ?? 0) > 0) {
      e.status = "completed";
    } else {
      // Ran the full ~24-month plan with no engagement -> quarterly-floor only.
      e.status = "dormant";
      e.nextDueAt = new Date(at.getTime() + weeksMs(QUARTER_WEEKS)).toISOString();
    }
  } else {
    const next = plan[e.nextTouchIndex];
    e.nextDueAt = scheduleTouchAt(e.enrolledAt, next, e.nextTouchIndex);
  }
  persist();
}

/** Reschedule a dormant enrollment's next quarterly-floor touch after one fires. */
export function advanceDormant(prospectId: string, at: Date = new Date()): void {
  const e = getEnrollment(prospectId);
  if (!e || e.status !== "dormant") return;
  e.touchesSent += 1;
  e.lastTouchAt = at.toISOString();
  e.nextDueAt = new Date(at.getTime() + weeksMs(QUARTER_WEEKS)).toISOString();
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

const NURTURE_SYSTEM = `You write a single follow-up nurture touch from an executive-search and talent advisory professional (Ryan / Lume) to a senior leader already in a long-term, relationship-building sequence. This is NOT a pitch and NOT a sales message. It is a peer-level, value-first touch that keeps a real relationship warm.

Rules:
- Sound like an industry peer and search advisor who genuinely follows their space; never a transactional recruiter, staffing agency, or salesperson.
- Be specific to their EXACT role and industry. Speak their language, metrics, and current pressures. Generalize to any title or sector with real depth; never sound like a template.
- Deliver one genuinely useful idea, observation, or acknowledgement. Never ask for a meeting or for business.
- Ground only in the real context provided. Never invent facts, posts, numbers, events, or client outcomes.
- Plain text. No emojis, no hashtags, NO dashes of any kind (no em dashes, no en dashes, no hyphens; write compounds as separate words), no links unless provided.
- Channel limits:
  - email: 60-110 words, with a quiet, peer-level subject line (never a pitch).
  - linkedin_comment: <= 300 characters, reads as a natural, thoughtful comment a peer would leave on their content.
  - linkedin_voice_note: a 20-35 second spoken script (~50-90 words), warm and conversational, written to be heard.

${BD_POSITIONING}

${HOUSE_VOICE}`;

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
    subject: typeof o.subject === "string" ? sanitizeDashes(o.subject.trim()) : undefined,
    body: typeof o.body === "string" ? sanitizeDashes(o.body.trim()) : "",
  };
}
