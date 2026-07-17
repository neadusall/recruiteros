/**
 * RecruitersOS · Phone · Store
 *
 * In-memory reference store + debounced snapshot (SNAP_KEY "phone_system"),
 * the same durability seam as voice_drops / billing: survives restarts when
 * DATABASE_URL / a file volume is set, runs purely in-memory otherwise.
 *
 * Entities stay separate, typed collections (lines, per-user state, calls,
 * follow-ups, settings) so history filtering / analytics query real fields,
 * never a JSON grab-bag. Call volume is bounded per workspace (oldest
 * terminal calls age out past the cap).
 */

import { rid, nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";
import type { Motion } from "../core/types";
import {
  type PhoneLine, type PhoneUserState, type CallRecord, type CallFollowUp,
  type PhoneSettings, type CallQuery, type CallEvent, type PhoneInfra,
  DEFAULT_PHONE_SETTINGS, asBdAnalysis,
} from "./types";

/** Max calls kept per workspace; oldest ended calls drop first past this. */
const MAX_CALLS_PER_WORKSPACE = 5000;
/** Max events retained on one call record. */
const MAX_EVENTS_PER_CALL = 60;

const store = {
  /** Keyed by workspaceId. */
  infra: {} as Record<string, PhoneInfra>,
  lines: [] as PhoneLine[],
  /** Keyed by `${workspaceId}:${userId}`. */
  userState: {} as Record<string, PhoneUserState>,
  calls: [] as CallRecord[],
  followUps: [] as CallFollowUp[],
  /** Keyed by `${workspaceId}:${motion}`. */
  settings: {} as Record<string, PhoneSettings>,
};

/* ---------------- durability ---------------- */

const SNAP_KEY = "phone_system";
function serialize() {
  return store;
}
function hydrate(s: any) {
  if (!s) return;
  store.infra = s.infra ?? {};
  store.lines = s.lines ?? [];
  store.userState = s.userState ?? {};
  store.calls = s.calls ?? [];
  store.followUps = s.followUps ?? [];
  store.settings = s.settings ?? {};
}
const persist = debouncedSaver(SNAP_KEY, serialize);

let hydrated: Promise<void> | null = null;
export function ensurePhoneReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled()
      ? loadSnapshot<any>(SNAP_KEY).then(hydrate).catch(() => {})
      : Promise.resolve();
  }
  return hydrated;
}
void ensurePhoneReady();

/* ---------------- infra ---------------- */

export function getInfra(workspaceId: string): PhoneInfra {
  let inf = store.infra[workspaceId];
  if (!inf) {
    inf = { workspaceId, updatedAt: nowIso() };
    store.infra[workspaceId] = inf;
  }
  return inf;
}

export function patchInfra(workspaceId: string, patch: Partial<PhoneInfra>): PhoneInfra {
  const inf = getInfra(workspaceId);
  const { workspaceId: _w, ...safe } = patch as any;
  Object.assign(inf, safe, { updatedAt: nowIso() });
  persist();
  return inf;
}

/* ---------------- lines ---------------- */

export function listLines(workspaceId: string, motion?: Motion): PhoneLine[] {
  return store.lines
    .filter((l) => l.workspaceId === workspaceId && (!motion || l.motion === motion))
    .sort((a, b) => a.e164.localeCompare(b.e164));
}

export function getLine(workspaceId: string, id: string): PhoneLine | undefined {
  return store.lines.find((l) => l.workspaceId === workspaceId && l.id === id);
}

export function findLineByNumber(e164: string): PhoneLine | undefined {
  const key = last10(e164);
  return store.lines.find((l) => last10(l.e164) === key);
}

export function upsertLine(
  workspaceId: string,
  input: Partial<PhoneLine> & { e164: string; motion: Motion },
): PhoneLine {
  const existing = store.lines.find(
    (l) => l.workspaceId === workspaceId && last10(l.e164) === last10(input.e164),
  );
  if (existing) {
    Object.assign(existing, {
      ...input,
      id: existing.id,
      workspaceId,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    });
    persist();
    return existing;
  }
  const line: PhoneLine = {
    id: rid("line"),
    workspaceId,
    e164: input.e164,
    telnyxNumberId: input.telnyxNumberId,
    connectionId: input.connectionId,
    label: input.label || input.e164,
    motion: input.motion,
    assignedUserIds: input.assignedUserIds ?? [],
    inboundEnabled: input.inboundEnabled ?? false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.lines.push(line);
  persist();
  return line;
}

export function patchLine(
  workspaceId: string, id: string, patch: Partial<PhoneLine>,
): PhoneLine | undefined {
  const line = getLine(workspaceId, id);
  if (!line) return undefined;
  const { id: _i, workspaceId: _w, createdAt: _c, ...safe } = patch as any;
  Object.assign(line, safe, { updatedAt: nowIso() });
  persist();
  return line;
}

export function deleteLine(workspaceId: string, id: string): boolean {
  const i = store.lines.findIndex((l) => l.workspaceId === workspaceId && l.id === id);
  if (i < 0) return false;
  store.lines.splice(i, 1);
  // Clear the line off any user who had it active.
  for (const st of Object.values(store.userState)) {
    if (st.workspaceId === workspaceId && st.activeLineId === id) st.activeLineId = undefined;
  }
  persist();
  return true;
}

/** Lines a given user may call from (assigned, or admin sees all). */
export function linesForUser(
  workspaceId: string, userId: string, isAdmin: boolean, motion?: Motion,
): PhoneLine[] {
  return listLines(workspaceId, motion).filter(
    (l) => isAdmin || l.assignedUserIds.includes(userId),
  );
}

/**
 * A recruiter's outbound identity as one E.164: the line they picked as active,
 * else their first assigned recruiting line, else any assigned line. This is
 * the number every channel should present — the browser phone already dials
 * from it, and OS Text pushes stamp it as the campaign's SMS from-number, so
 * assigning a number on the Numbers page ties calls AND texts to it.
 */
export function numberForUser(workspaceId: string, userId: string): string | undefined {
  const mine = listLines(workspaceId).filter((l) => l.assignedUserIds.includes(userId));
  if (!mine.length) return undefined;
  const st = getUserState(workspaceId, userId);
  const active = mine.find((l) => l.id === st.activeLineId);
  const recruiting = mine.find((l) => l.motion === "recruiting");
  return (active ?? recruiting ?? mine[0]).e164;
}

/* ---------------- per-user state ---------------- */

export function getUserState(workspaceId: string, userId: string): PhoneUserState {
  const key = `${workspaceId}:${userId}`;
  let st = store.userState[key];
  if (!st) {
    st = { userId, workspaceId, updatedAt: nowIso() };
    store.userState[key] = st;
  }
  return st;
}

export function patchUserState(
  workspaceId: string, userId: string, patch: Partial<PhoneUserState>,
): PhoneUserState {
  const st = getUserState(workspaceId, userId);
  const { userId: _u, workspaceId: _w, ...safe } = patch as any;
  Object.assign(st, safe, { updatedAt: nowIso() });
  persist();
  return st;
}

/** Find which portal user a SIP username belongs to (inbound leg routing). */
export function findUserBySipUsername(sipUsername: string): PhoneUserState | undefined {
  return Object.values(store.userState).find((s) => s.sipUsername === sipUsername);
}

/* ---------------- calls ---------------- */

export function insertCall(call: Omit<CallRecord, "id" | "createdAt" | "updatedAt">): CallRecord {
  const rec: CallRecord = { ...call, id: rid("call"), createdAt: nowIso(), updatedAt: nowIso() };
  store.calls.push(rec);
  trimCalls(rec.workspaceId);
  persist();
  return rec;
}

export function getCall(workspaceId: string, id: string): CallRecord | undefined {
  return store.calls.find((c) => c.workspaceId === workspaceId && c.id === id);
}

/** Webhook-side lookup: the call id arrives in client_state without workspace
 *  context; the record itself carries the workspace for cred scoping. */
export function getCallById(id: string): CallRecord | undefined {
  return store.calls.find((c) => c.id === id);
}

/** Webhook correlation: Telnyx ids arrive without workspace context. */
export function findCallByControlId(ccid: string): CallRecord | undefined {
  return store.calls.find((c) => c.telnyxCallControlId === ccid);
}

export function findCallBySessionId(sessionId: string): CallRecord | undefined {
  return store.calls.find((c) => c.telnyxSessionId === sessionId);
}

/** The user's newest not-yet-terminal call, if any (client state resume).
 *  A ringing inbound call has no owner yet; it counts as "mine" when this
 *  user's browser is in its ring set (agentLegs). */
export function findLiveCall(workspaceId: string, userId: string): CallRecord | undefined {
  return [...store.calls]
    .reverse()
    .find(
      (c) =>
        c.workspaceId === workspaceId &&
        (c.status === "ringing" || c.status === "active" || c.status === "held") &&
        (c.userId === userId || (c.agentLegs ?? []).some((l) => l.userId === userId)),
    );
}

export function updateCall(
  call: CallRecord, patch: Partial<CallRecord>,
): CallRecord {
  const { id: _i, workspaceId: _w, createdAt: _c, ...safe } = patch as any;
  Object.assign(call, safe, { updatedAt: nowIso() });
  persist();
  return call;
}

export function logCallEvent(call: CallRecord, type: string, detail?: string): void {
  const ev: CallEvent = { at: nowIso(), type, ...(detail ? { detail } : {}) };
  call.events.push(ev);
  if (call.events.length > MAX_EVENTS_PER_CALL) {
    call.events.splice(0, call.events.length - MAX_EVENTS_PER_CALL);
  }
  call.updatedAt = nowIso();
  persist();
}

/** Filterable, newest-first history with a total for pagination. */
export function queryCalls(
  workspaceId: string, motion: Motion, q: CallQuery = {},
): { calls: CallRecord[]; total: number } {
  const needle = (q.q ?? "").trim().toLowerCase();
  const fromTs = q.from ? Date.parse(q.from) : NaN;
  const toTs = q.to ? Date.parse(q.to) : NaN;

  const rows = store.calls
    .filter((c) => {
      if (c.workspaceId !== workspaceId || c.motion !== motion) return false;
      if (q.direction === "missed") {
        if (!(c.status === "missed" || c.status === "declined")) return false;
      } else if (q.direction && c.direction !== q.direction) return false;
      if (q.status && c.status !== q.status) return false;
      if (q.userId && c.userId !== q.userId) return false;
      if (q.lineId && c.lineId !== q.lineId) return false;
      if (q.opportunity) {
        const opp = c.analysisOverrides?.opportunity?.value ?? asBdAnalysis(c.analysis)?.opportunity;
        if (opp !== q.opportunity) return false;
      }
      if (Number.isFinite(fromTs) && Date.parse(c.startedAt) < fromTs) return false;
      if (Number.isFinite(toTs) && Date.parse(c.startedAt) > toTs) return false;
      if (needle) {
        const hay = [
          c.externalNumber, c.contactName, c.companyName, c.contactTitle,
          c.userName, c.lineNumber, c.analysis?.summary, c.userNotes,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    })
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

  const total = rows.length;
  const offset = Math.max(0, q.offset ?? 0);
  const limit = Math.max(1, Math.min(200, q.limit ?? 50));
  return { calls: rows.slice(offset, offset + limit), total };
}

/** Calls stuck mid-pipeline (for the retry sweep). */
export function callsInPipeline(stages: CallRecord["pipeline"][]): CallRecord[] {
  return store.calls.filter((c) => stages.includes(c.pipeline));
}

/** Live tiles for the phone tab: today's activity plus the week's pipeline. */
export interface PhoneDayStats {
  /** Calls today (any direction/outcome). */
  callsToday: number;
  /** Answered conversations today. */
  connectedToday: number;
  /** Talk seconds today (answered call durations). */
  talkSecToday: number;
  /** Calls in the last 7 days classified hot or warm (override-aware). */
  hotWarmWeek: number;
}

export function phoneDayStats(workspaceId: string, motion: Motion): PhoneDayStats {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const day = dayStart.getTime();
  const week = Date.now() - 7 * 86_400_000;
  const out: PhoneDayStats = { callsToday: 0, connectedToday: 0, talkSecToday: 0, hotWarmWeek: 0 };
  for (const c of store.calls) {
    if (c.workspaceId !== workspaceId || c.motion !== motion) continue;
    const t = Date.parse(c.startedAt);
    if (!Number.isFinite(t)) continue;
    if (t >= day) {
      out.callsToday++;
      if (c.answeredAt) {
        out.connectedToday++;
        out.talkSecToday += c.durationSec ?? 0;
      }
    }
    if (t >= week) {
      const opp = c.analysisOverrides?.opportunity?.value ?? asBdAnalysis(c.analysis)?.opportunity;
      if (opp === "hot" || opp === "warm") out.hotWarmWeek++;
    }
  }
  return out;
}

/** One dialable entry in the "call queue": an open follow-up joined to its
 *  call so the UI can place the call in one click. Overdue first. */
export interface CallQueueItem {
  followUpId: string;
  callId: string;
  title: string;
  dueDate?: string;
  overdue: boolean;
  contactName?: string;
  companyName?: string;
  number?: string;
  /** Override-aware opportunity of the source call, for the row's pill. */
  opportunity?: string;
}

export function callQueue(workspaceId: string, motion: Motion, limit = 8): CallQueueItem[] {
  const today = new Date().toISOString().slice(0, 10);
  const rows = store.followUps
    .filter((f) => f.workspaceId === workspaceId && f.motion === motion && f.status === "open")
    .map((f): CallQueueItem => {
      const call = store.calls.find((c) => c.id === f.callId);
      const opp = call
        ? call.analysisOverrides?.opportunity?.value ?? asBdAnalysis(call.analysis)?.opportunity
        : undefined;
      return {
        followUpId: f.id,
        callId: f.callId,
        title: f.title,
        dueDate: f.dueDate,
        overdue: Boolean(f.dueDate && f.dueDate < today),
        contactName: f.contactName ?? call?.contactName,
        companyName: f.companyName ?? call?.companyName,
        number: call?.externalNumber,
        opportunity: opp,
      };
    });
  // Overdue first, then dated soonest-first, then undated by recency.
  rows.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });
  return rows.slice(0, limit);
}

function trimCalls(workspaceId: string): void {
  const mine = store.calls.filter((c) => c.workspaceId === workspaceId);
  if (mine.length <= MAX_CALLS_PER_WORKSPACE) return;
  const terminal = new Set(["completed", "missed", "declined", "canceled", "failed"]);
  const removable = mine
    .filter((c) => terminal.has(c.status))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    .slice(0, mine.length - MAX_CALLS_PER_WORKSPACE);
  const drop = new Set(removable.map((c) => c.id));
  if (drop.size) store.calls = store.calls.filter((c) => !drop.has(c.id));
}

/* ---------------- follow-ups ---------------- */

export function listFollowUps(
  workspaceId: string, motion: Motion, opts: { callId?: string; status?: CallFollowUp["status"] } = {},
): CallFollowUp[] {
  return store.followUps
    .filter(
      (f) =>
        f.workspaceId === workspaceId && f.motion === motion &&
        (!opts.callId || f.callId === opts.callId) &&
        (!opts.status || f.status === opts.status),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function insertFollowUp(
  input: Omit<CallFollowUp, "id" | "createdAt">,
): CallFollowUp {
  // One follow-up per AI action item per call: clicking twice must not dupe.
  if (input.actionItemId) {
    const dupe = store.followUps.find(
      (f) => f.callId === input.callId && f.actionItemId === input.actionItemId,
    );
    if (dupe) return dupe;
  }
  const f: CallFollowUp = { ...input, id: rid("fup"), createdAt: nowIso() };
  store.followUps.push(f);
  persist();
  return f;
}

export function patchFollowUp(
  workspaceId: string, id: string, patch: Partial<CallFollowUp>,
): CallFollowUp | undefined {
  const f = store.followUps.find((x) => x.workspaceId === workspaceId && x.id === id);
  if (!f) return undefined;
  const { id: _i, workspaceId: _w, createdAt: _c, ...safe } = patch as any;
  Object.assign(f, safe);
  if (patch.status === "done" && !f.completedAt) f.completedAt = nowIso();
  persist();
  return f;
}

/* ---------------- settings ---------------- */

export function getPhoneSettings(workspaceId: string, motion: Motion): PhoneSettings {
  return { ...DEFAULT_PHONE_SETTINGS, ...(store.settings[`${workspaceId}:${motion}`] ?? {}) };
}

export function savePhoneSettings(
  workspaceId: string, motion: Motion, patch: Partial<PhoneSettings>,
): PhoneSettings {
  const merged = { ...getPhoneSettings(workspaceId, motion), ...patch };
  store.settings[`${workspaceId}:${motion}`] = merged;
  persist();
  return merged;
}

/* ---------------- helpers ---------------- */

/** Last 10 digits: tolerant phone matching (+1 / 1 / formatting agnostic). */
export function last10(phone: string): string {
  const d = (phone || "").replace(/\D/g, "");
  return d.slice(-10);
}
