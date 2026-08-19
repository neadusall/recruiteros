/**
 * RecruitersOS · Phone Intelligence · Contact outreach ledger + number rotation
 *
 * The per-contact rules (user spec):
 *  - Every LIVE answer → burn the calling number for that contact (never dial
 *    them from it again) and count the live answer.
 *  - Every VOICEMAIL left → remember that number as the contact's PREFERRED
 *    number for follow-ups, and count the voicemail.
 *  - When choosing which of our lines to dial a contact from, skip burned
 *    numbers and prefer the one that already reached their voicemail.
 *
 * Self-contained snapshot (phone_intel_outreach_v1) so it stays decoupled from
 * the call store.
 */

import { rid, nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";
import type { ContactOutreachState } from "./types";

const SNAP_KEY = "phone_intel_outreach_v1";
const store = { rows: [] as ContactOutreachState[] };
const persist = debouncedSaver(SNAP_KEY, () => store);

let hydrated: Promise<void> | null = null;
export function ensureOutreachReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled()
      ? loadSnapshot<any>(SNAP_KEY).then((s) => { if (s?.rows) store.rows = s.rows; }).catch(() => {})
      : Promise.resolve();
  }
  return hydrated;
}
void ensureOutreachReady();

const last10 = (p: string) => (p || "").replace(/\D/g, "").slice(-10);

export function contactKeyOf(input: { contactId?: string; companyKey: string; targetFull: string }): string {
  if (input.contactId) return input.contactId;
  return `${input.companyKey}|${input.targetFull.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

function get(workspaceId: string, contactKey: string): ContactOutreachState | undefined {
  return store.rows.find((r) => r.workspaceId === workspaceId && r.contactKey === contactKey);
}

export function getOutreach(
  workspaceId: string,
  input: { contactId?: string; companyKey: string; targetFull: string },
): ContactOutreachState {
  const contactKey = contactKeyOf(input);
  let row = get(workspaceId, contactKey);
  if (!row) {
    row = {
      id: rid("out"),
      workspaceId,
      contactKey,
      companyKey: input.companyKey,
      contactId: input.contactId,
      targetFull: input.targetFull,
      liveAnswerCount: 0,
      voicemailCount: 0,
      burnedNumbers: [],
      updatedAt: nowIso(),
    };
    store.rows.push(row);
    persist();
  }
  return row;
}

/**
 * Choose which of our lines to dial this contact from: never a burned number;
 * prefer the number that already reached their voicemail; else the first free
 * line; else (all burned) undefined so the caller holds — the user rule is
 * "swap out numbers so they don't get a call from that number again."
 */
export function pickFromNumber(
  workspaceId: string,
  input: { contactId?: string; companyKey: string; targetFull: string },
  pool: string[],
): { number?: string; exhausted: boolean } {
  const row = getOutreach(workspaceId, input);
  const burned = new Set(row.burnedNumbers.map(last10));
  const free = pool.filter((n) => !burned.has(last10(n)));
  if (row.preferredNumber && free.some((n) => last10(n) === last10(row.preferredNumber!))) {
    return { number: row.preferredNumber, exhausted: false };
  }
  if (!free.length) return { number: undefined, exhausted: true };
  return { number: free[0], exhausted: false };
}

/** Record a live-person answer: burn the number for this contact. */
export function recordLiveAnswer(
  workspaceId: string,
  input: { contactId?: string; companyKey: string; targetFull: string },
  fromNumber: string,
): ContactOutreachState {
  const row = getOutreach(workspaceId, input);
  row.liveAnswerCount += 1;
  if (!row.burnedNumbers.some((n) => last10(n) === last10(fromNumber))) {
    row.burnedNumbers.push(fromNumber);
  }
  if (row.preferredNumber && last10(row.preferredNumber) === last10(fromNumber)) {
    row.preferredNumber = undefined; // a preferred number that now hits a human is no longer preferred
  }
  row.lastOutcome = "live";
  row.lastCalledAt = nowIso();
  row.updatedAt = nowIso();
  persist();
  return row;
}

/** Record a voicemail left: stick to this number for follow-ups. */
export function recordVoicemail(
  workspaceId: string,
  input: { contactId?: string; companyKey: string; targetFull: string },
  fromNumber: string,
): ContactOutreachState {
  const row = getOutreach(workspaceId, input);
  row.voicemailCount += 1;
  if (!row.burnedNumbers.some((n) => last10(n) === last10(fromNumber))) {
    row.preferredNumber = fromNumber;
  }
  row.lastOutcome = "voicemail";
  row.lastCalledAt = nowIso();
  row.updatedAt = nowIso();
  persist();
  return row;
}

export function listOutreach(workspaceId: string): ContactOutreachState[] {
  return store.rows
    .filter((r) => r.workspaceId === workspaceId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** Workspace rollup for the dashboard: live vs voicemail totals. */
export function outreachTotals(workspaceId: string): { liveAnswers: number; voicemails: number; contacts: number } {
  const rows = store.rows.filter((r) => r.workspaceId === workspaceId);
  return {
    liveAnswers: rows.reduce((a, r) => a + r.liveAnswerCount, 0),
    voicemails: rows.reduce((a, r) => a + r.voicemailCount, 0),
    contacts: rows.length,
  };
}
