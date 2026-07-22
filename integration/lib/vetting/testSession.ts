/**
 * RecruitersOS · AI Vetting · Mock-interview test sessions (ephemeral)
 *
 * The desk card's "Test drive" full-interview mode lets the operator hand the
 * agent a resume and get the REAL vetting interview against the desk's job
 * description: same coverage-review gaps, same personalized prepared
 * questions, same arc a real candidate gets. That prepared context has to
 * reach the call on BOTH channels that can supply dynamic variables: the
 * scheduled event carries them at creation, and the context webhook
 * re-resolves them when the call actually connects. This module is the bridge
 * for the webhook side: a small in-memory, TTL'd map keyed by desk + phone.
 *
 * Deliberately NOT in the store: a test is a rehearsal, not a candidate. No
 * opt-in, no chase ladder, no client package, nothing persisted. If the app
 * restarts in the ~15 seconds between arming the test and the call firing,
 * the scheduled event's own variables still carry the interview.
 */

import type { PersonalQuestion } from "./types";

export interface TestInterviewSession {
  deskId: string;
  workspaceId: string;
  /** Last-10-digit key of the number the agent dials. */
  phoneKey: string;
  firstName: string;
  lastName: string;
  resumeText: string;
  /** Pre-rendered gap lines (same shape the context webhook builds for real screens). */
  resumeGaps: string;
  questions: PersonalQuestion[];
  createdAt: number;
}

/** Long enough to pick up late or call the desk number back; short enough to never leak into a real screen. */
const TTL_MS = 3 * 60 * 60 * 1000;

const sessions = new Map<string, TestInterviewSession>();

function phoneKey(phone: string): string {
  return String(phone || "").replace(/\D+/g, "").slice(-10);
}

function prune(): void {
  const now = Date.now();
  for (const [k, s] of sessions) {
    if (now - s.createdAt > TTL_MS) sessions.delete(k);
  }
}

/** Arm (or re-arm) the mock interview for one desk + number. */
export function registerTestInterview(s: Omit<TestInterviewSession, "phoneKey" | "createdAt"> & { phone: string }): void {
  prune();
  const key = phoneKey(s.phone);
  if (!key) return;
  sessions.set(`${s.deskId}|${key}`, {
    deskId: s.deskId,
    workspaceId: s.workspaceId,
    phoneKey: key,
    firstName: s.firstName,
    lastName: s.lastName,
    resumeText: s.resumeText,
    resumeGaps: s.resumeGaps,
    questions: s.questions,
    createdAt: Date.now(),
  });
}

/** The active mock interview for this desk + caller, if one is armed. */
export function getTestInterview(deskId: string, phone: string): TestInterviewSession | undefined {
  prune();
  const key = phoneKey(phone);
  if (!key) return undefined;
  return sessions.get(`${deskId}|${key}`);
}
