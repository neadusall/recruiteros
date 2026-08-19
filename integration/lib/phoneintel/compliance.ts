/**
 * RecruitersOS · Phone Intelligence · Compliance & velocity guard (spec §44-49)
 *
 * Every discovery call passes through preCallCheck() first. Fail-closed: if we
 * can't establish the callee's local time, we don't dial. Velocity caps protect
 * both the target (company fatigue) and our own number reputation — the
 * legitimate alternative to gaming carrier metrics.
 *
 * Recording is decided per-jurisdiction (spec §44): in all-party-consent states
 * we do NOT record the human-conversation portion of a call. IVR menus and
 * voicemail greetings (machine audio, no human on the line) are treated
 * separately by the orchestrator.
 */

import { checkWindow, HARD_WINDOW } from "../voice/compliance";
import type { ComplianceWindow } from "../voice/types";
import { listCalls } from "./store";

/** US states requiring all-party consent to record a call (conservative list). */
const ALL_PARTY_CONSENT = new Set([
  "CA", "CT", "FL", "IL", "MD", "MA", "MI", "MT", "NV", "NH", "OR", "PA", "WA", "DE",
]);

export const VELOCITY = {
  MAX_CALLS_NUMBER_DAY: 200,
  MAX_CALLS_NUMBER_HOUR: 40,
  MAX_CALLS_COMPANY_DAY: 4, // don't hammer one switchboard (spec §48)
  MAX_CALLS_CONTACT_WEEK: 2, // spec §49
  MIN_RETRY_INTERVAL_MS: 60 * 60_000,
} as const;

export interface PreCallInput {
  workspaceId: string;
  companyKey: string;
  contactId?: string;
  fromNumber: string;
  /** Callee location string (e.g. "Austin, TX") for the timezone/hours check. */
  location?: string;
  /** Callee state code (e.g. "CA") for the recording decision. */
  stateCode?: string;
  window?: ComplianceWindow;
  now?: Date;
}

export interface PreCallDecision {
  allowed: boolean;
  reason?: string;
  timezone?: string;
  localHour?: number;
  /** Whether the human-conversation portion may be recorded in this jurisdiction. */
  mayRecordHuman: boolean;
}

function stateFromLocation(location?: string): string | undefined {
  const m = (location || "").match(/,\s*([A-Za-z]{2})\b/);
  return m ? m[1].toUpperCase() : undefined;
}

/** Human-conversation recording allowed only outside all-party-consent states. */
export function mayRecordHuman(stateCode?: string, location?: string): boolean {
  const s = (stateCode || stateFromLocation(location) || "").toUpperCase();
  if (!s) return false; // unknown jurisdiction → conservative: no human recording
  return !ALL_PARTY_CONSENT.has(s);
}

export function preCallCheck(input: PreCallInput): PreCallDecision {
  const now = input.now ?? new Date();
  const recHuman = mayRecordHuman(input.stateCode, input.location);

  // 1. Calling window (fail-closed on unknown timezone).
  const win = checkWindow(input.location, input.window ?? HARD_WINDOW, now);
  if (!win.allowed) {
    return { allowed: false, reason: `hours:${win.reason}`, timezone: win.timezone, localHour: win.localHour, mayRecordHuman: recHuman };
  }

  // 2. Velocity + fatigue (read recent history from the store).
  const recent = listCalls(input.workspaceId, 2000);
  const t = now.getTime();
  const dayAgo = t - 86_400_000, hourAgo = t - 3_600_000, weekAgo = t - 7 * 86_400_000;
  const at = (c: { startedAt: string }) => Date.parse(c.startedAt);

  const numDay = recent.filter((c) => c.fromNumber === input.fromNumber && at(c) >= dayAgo).length;
  if (numDay >= VELOCITY.MAX_CALLS_NUMBER_DAY) return deny("velocity:number_day", recHuman);
  const numHour = recent.filter((c) => c.fromNumber === input.fromNumber && at(c) >= hourAgo).length;
  if (numHour >= VELOCITY.MAX_CALLS_NUMBER_HOUR) return deny("velocity:number_hour", recHuman);

  const compDay = recent.filter((c) => c.companyKey === input.companyKey && at(c) >= dayAgo).length;
  if (compDay >= VELOCITY.MAX_CALLS_COMPANY_DAY) return deny("fatigue:company_day", recHuman);

  if (input.contactId) {
    const contactWeek = recent.filter((c) => c.targetContactId === input.contactId && at(c) >= weekAgo).length;
    if (contactWeek >= VELOCITY.MAX_CALLS_CONTACT_WEEK) return deny("velocity:contact_week", recHuman);
    const lastContact = recent.find((c) => c.targetContactId === input.contactId);
    if (lastContact && t - at(lastContact) < VELOCITY.MIN_RETRY_INTERVAL_MS) return deny("velocity:retry_interval", recHuman);
  }

  return { allowed: true, timezone: win.timezone, localHour: win.localHour, mayRecordHuman: recHuman };
}

function deny(reason: string, recHuman: boolean): PreCallDecision {
  return { allowed: false, reason, mayRecordHuman: recHuman };
}
