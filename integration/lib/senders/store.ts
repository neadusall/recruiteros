/**
 * RecruitersOS · Senders · registry store
 *
 * Workspace-scoped (= portal-scoped) registry of recruiter-owned SMTP inboxes.
 * In memory for fast reads, snapshotted to the durable backend (same pattern as
 * lib/sending/store.ts). Inboxes never leak across portals because every query is
 * filtered by workspaceId.
 */

import { rid, nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver } from "../db";
import { encryptSecret } from "./crypto";
import type { SenderInbox, SenderInboxPublic, SenderProvider, SenderStatus, RecruiterPool } from "./types";

interface SendersState { inboxes: SenderInbox[]; }

const KEY = "senders_v1";
let state: SendersState = { inboxes: [] };
let hydrated = false;
let hydrating: Promise<void> | null = null;

const save = debouncedSaver(KEY, () => state);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<SendersState>(KEY);
      if (snap && Array.isArray(snap.inboxes)) state = { inboxes: snap.inboxes };
      hydrated = true;
    })();
  }
  return hydrating;
}

export async function ready(): Promise<void> { return hydrate(); }
export function persist(): void { save(); }

/** Strip secrets + compute derived fields for the client. */
export function toPublic(m: SenderInbox): SenderInboxPublic {
  return {
    id: m.id, workspaceId: m.workspaceId, ownerId: m.ownerId, ownerName: m.ownerName,
    email: m.email, displayName: m.displayName, provider: m.provider,
    smtpHost: m.smtpHost, smtpPort: m.smtpPort, smtpSecure: m.smtpSecure, smtpUser: m.smtpUser,
    imapHost: m.imapHost, imapPort: m.imapPort, imapUser: m.imapUser, hasImap: !!m.imapHost,
    dailyCap: m.dailyCap, sentToday: m.sentToday, remaining: Math.max(0, m.dailyCap - m.sentToday),
    status: m.status, warmExternal: m.warmExternal,
    sent: m.sent, bounced: m.bounced, lastSendAt: m.lastSendAt, lastError: m.lastError,
    pausedReason: m.pausedReason, createdAt: m.createdAt, updatedAt: m.updatedAt,
  };
}

export interface NewInboxInput {
  email: string;
  displayName?: string;
  provider?: SenderProvider;
  smtpHost: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass: string;
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  imapPass?: string;
  ownerId?: string;
  ownerName?: string;
  dailyCap?: number;
  status?: SenderStatus;
  warmExternal?: boolean;
}

function normalizePort(p: number | undefined, fallback: number): number {
  const n = Number(p);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

export async function listInboxes(workspaceId: string, opts: { ownerId?: string } = {}): Promise<SenderInbox[]> {
  await hydrate();
  return state.inboxes.filter((m) => m.workspaceId === workspaceId && (!opts.ownerId || m.ownerId === opts.ownerId));
}

export async function getInbox(workspaceId: string, id: string): Promise<SenderInbox | undefined> {
  await hydrate();
  return state.inboxes.find((m) => m.id === id && m.workspaceId === workspaceId);
}

export async function findInboxByEmail(workspaceId: string, email: string): Promise<SenderInbox | undefined> {
  await hydrate();
  const e = email.toLowerCase().trim();
  return state.inboxes.find((m) => m.workspaceId === workspaceId && m.email.toLowerCase() === e);
}

/**
 * Add (or update, when the email already exists in this portal) an inbox. Re-uploading
 * the same address refreshes its credentials/settings rather than duplicating it, so
 * bulk re-imports are idempotent.
 */
export async function addInbox(workspaceId: string, input: NewInboxInput): Promise<SenderInbox> {
  await hydrate();
  const now = nowIso();
  const secure = input.smtpSecure ?? (normalizePort(input.smtpPort, 587) === 465);
  const email = input.email.toLowerCase().trim();
  const m: SenderInbox = {
    id: rid("sndr"),
    workspaceId,
    ownerId: input.ownerId,
    ownerName: input.ownerName,
    email,
    displayName: input.displayName,
    provider: input.provider || "own-smtp",
    smtpHost: input.smtpHost.trim(),
    smtpPort: normalizePort(input.smtpPort, secure ? 465 : 587),
    smtpSecure: secure,
    smtpUser: (input.smtpUser || input.email).trim(),
    smtpPassEnc: encryptSecret(input.smtpPass || ""),
    imapHost: input.imapHost?.trim() || undefined,
    imapPort: input.imapHost ? normalizePort(input.imapPort, 993) : undefined,
    imapUser: input.imapHost ? (input.imapUser || input.email).trim() : undefined,
    imapPassEnc: input.imapHost ? encryptSecret(input.imapPass || input.smtpPass || "") : undefined,
    dailyCap: input.dailyCap && input.dailyCap > 0 ? Math.round(input.dailyCap) : 40,
    sentToday: 0,
    status: input.status || "warming",
    warmExternal: input.warmExternal ?? true,
    sent: 0,
    bounced: 0,
    createdAt: now,
    updatedAt: now,
  };
  const existingIdx = state.inboxes.findIndex((x) => x.workspaceId === workspaceId && x.email === email);
  if (existingIdx >= 0) {
    const prev = state.inboxes[existingIdx];
    m.id = prev.id;
    m.sent = prev.sent;
    m.bounced = prev.bounced;
    m.sentToday = prev.sentToday;
    m.createdAt = prev.createdAt;
    // keep the prior owner if the re-import didn't specify one
    if (!m.ownerId && prev.ownerId) { m.ownerId = prev.ownerId; m.ownerName = prev.ownerName; }
    state.inboxes[existingIdx] = m;
  } else {
    state.inboxes.push(m);
  }
  save();
  return m;
}

export async function saveInbox(m: SenderInbox): Promise<void> {
  await hydrate();
  m.updatedAt = nowIso();
  const i = state.inboxes.findIndex((x) => x.id === m.id);
  if (i >= 0) state.inboxes[i] = m; else state.inboxes.push(m);
  save();
}

export async function deleteInbox(workspaceId: string, id: string): Promise<boolean> {
  await hydrate();
  const i = state.inboxes.findIndex((m) => m.id === id && m.workspaceId === workspaceId);
  if (i < 0) return false;
  state.inboxes.splice(i, 1);
  save();
  return true;
}

/** Bulk assign a set of inboxes to a recruiter (owner). Returns count changed. */
export async function assignOwner(workspaceId: string, ids: string[], ownerId: string, ownerName?: string): Promise<number> {
  await hydrate();
  const set = new Set(ids);
  let n = 0;
  for (const m of state.inboxes) {
    if (m.workspaceId === workspaceId && set.has(m.id)) {
      m.ownerId = ownerId;
      m.ownerName = ownerName;
      m.updatedAt = nowIso();
      n++;
    }
  }
  if (n) save();
  return n;
}

/** Set status (active/paused/etc.) for a set of inboxes. */
export async function setStatus(workspaceId: string, ids: string[], status: SenderStatus, pausedReason?: string): Promise<number> {
  await hydrate();
  const set = new Set(ids);
  let n = 0;
  for (const m of state.inboxes) {
    if (m.workspaceId === workspaceId && set.has(m.id)) {
      m.status = status;
      m.pausedReason = status === "paused" ? pausedReason : undefined;
      m.updatedAt = nowIso();
      n++;
    }
  }
  if (n) save();
  return n;
}

/** Per-recruiter pool summaries for the assignment UI. */
export async function recruiterPools(workspaceId: string): Promise<RecruiterPool[]> {
  await hydrate();
  const map = new Map<string, RecruiterPool>();
  for (const m of state.inboxes) {
    if (m.workspaceId !== workspaceId) continue;
    const key = m.ownerId || "_unassigned";
    let p = map.get(key);
    if (!p) {
      p = {
        ownerId: m.ownerId || "",
        ownerName: m.ownerName || (m.ownerId ? "(unknown)" : "Unassigned"),
        inboxes: 0, active: 0, dailyCapacity: 0, remainingToday: 0,
      };
      map.set(key, p);
    }
    p.inboxes++;
    if (m.status === "active" || m.status === "warming") {
      p.active++;
      p.dailyCapacity += m.dailyCap;
      p.remainingToday += Math.max(0, m.dailyCap - m.sentToday);
    }
  }
  return [...map.values()].sort((a, b) => b.inboxes - a.inboxes);
}

export async function stats(workspaceId: string): Promise<{ inboxes: number; active: number; recruiters: number; dailyCapacity: number; remainingToday: number }> {
  await hydrate();
  const mine = state.inboxes.filter((m) => m.workspaceId === workspaceId);
  const owners = new Set(mine.filter((m) => m.ownerId).map((m) => m.ownerId));
  let cap = 0, rem = 0, active = 0;
  for (const m of mine) {
    if (m.status === "active" || m.status === "warming") {
      active++;
      cap += m.dailyCap;
      rem += Math.max(0, m.dailyCap - m.sentToday);
    }
  }
  return { inboxes: mine.length, active, recruiters: owners.size, dailyCapacity: cap, remainingToday: rem };
}

/** Record a send against an inbox's daily cap + lifetime counter. */
export async function recordSend(m: SenderInbox): Promise<void> {
  await hydrate();
  m.sentToday += 1;
  m.sent += 1;
  m.lastSendAt = nowIso();
  m.updatedAt = nowIso();
  save();
}

/** Reset daily counters (call once per day from the daily tick). */
export async function resetDaily(workspaceId: string): Promise<void> {
  await hydrate();
  let changed = false;
  for (const m of state.inboxes) {
    if (m.workspaceId === workspaceId && m.sentToday !== 0) { m.sentToday = 0; changed = true; }
  }
  if (changed) save();
}

/** Distinct portal (workspace) ids that own at least one sender inbox. */
export async function listSenderWorkspaceIds(): Promise<string[]> {
  await hydrate();
  return [...new Set(state.inboxes.map((m) => m.workspaceId))];
}
