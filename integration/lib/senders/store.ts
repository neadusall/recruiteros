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
import { encryptSecret, decryptSecret } from "./crypto";
import { COLD_PER_INBOX, SENDING_AC_PER_INBOX, WARMING_PER_INBOX, INBOXES_PER_DOMAIN, coldCapFor, coldMaxPerInbox } from "./limits";
import type { SenderInbox, SenderInboxPublic, SenderProvider, SenderStatus, RecruiterPool } from "./types";

interface SendersState { inboxes: SenderInbox[]; lastResetDay?: string; }

const KEY = "senders_v1";
let state: SendersState = { inboxes: [] };
let hydrated = false;
let hydrating: Promise<void> | null = null;

const save = debouncedSaver(KEY, () => state);

const STRICT_B64 = /^[A-Za-z0-9+/]{16,}={0,2}$/;

/**
 * Decode a value ONLY when it is unambiguously a base64-ENCODED password, else
 * return null. Guards (all required):
 *   - strict base64 (alphabet + padding, length a multiple of 4, >= 16 chars)
 *   - decodes to all-printable ASCII of a plausible password length (8-48)
 *   - the decoded value is NOT itself base64-shaped -> the repair is IDEMPOTENT:
 *     a later boot sees the now-plaintext password and leaves it untouched, so we
 *     can never double-decode.
 * A real plaintext password that merely "looks base64-ish" is not decoded because
 * it would either fail the printable-ASCII/length checks or (paired with the
 * auth-error gate below) never reach here at all.
 */
export function decodeBase64Password(cur: string): string | null {
  if (!STRICT_B64.test(cur) || cur.length % 4 !== 0) return null;
  let buf: Buffer;
  try { buf = Buffer.from(cur, "base64"); } catch { return null; }
  if (buf.length < 8 || buf.length > 48) return null;
  for (const b of buf) { if (b < 0x20 || b > 0x7e) return null; }
  const dec = buf.toString("utf8");
  if (dec === cur) return null;
  if (STRICT_B64.test(dec) && dec.length % 4 === 0) return null; // ambiguous -> leave alone
  return dec;
}

/**
 * Self-healing repair for a historical import bug: the warm-up engine exports
 * mailbox passwords base64-ENCODED, and an early importer stored them without
 * decoding, so those logins were rejected (535/454 authentication failed).
 * We repair a stored password IN PLACE only when the inbox is currently in ERROR
 * (a credential that authenticates is status active or warming, never error, so a
 * working password is never touched whatever its shape) AND the stored value is
 * unambiguously base64 per decodeBase64Password. Runs at hydrate (once per boot),
 * which also inoculates against a base64 password reappearing after a re-import
 * once that inbox fails and is marked in error.
 *
 * Deliberately NOT gated on provider. Base64 encoding is a property of the
 * upstream export, not of how we classify the mailbox: the warm-up fleet serves
 * externally-hosted SMTP accounts (provider "other", e.g. Google-hosted domains
 * on smtp.gmail.com) the same encoded way it serves our own server's. Gating on
 * own-smtp left every such mailbox latched in error with no way out.
 */
function healBase64Passwords(inboxes: SenderInbox[]): number {
  let fixed = 0;
  for (const m of inboxes) {
    if (m.status !== "error") continue;
    if (!m.smtpPassEnc) continue;
    const dec = decodeBase64Password(decryptSecret(m.smtpPassEnc));
    if (dec) { m.smtpPassEnc = encryptSecret(dec); m.updatedAt = nowIso(); fixed++; }
  }
  return fixed;
}

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<SendersState>(KEY);
      if (snap && Array.isArray(snap.inboxes)) state = { inboxes: snap.inboxes, lastResetDay: snap.lastResetDay };
      const healed = healBase64Passwords(state.inboxes);
      if (healed) { save(); console.log(`[senders] self-healed ${healed} base64-encoded SMTP password(s) at hydrate`); }
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
    dailyCap: coldCapFor(m), sentToday: m.sentToday, remaining: Math.max(0, coldCapFor(m) - m.sentToday),
    hasSmtpCreds: !!m.smtpPassEnc,
    status: m.status, warmExternal: m.warmExternal,
    sent: m.sent, bounced: m.bounced, lastSendAt: m.lastSendAt, lastError: m.lastError,
    pausedReason: m.pausedReason,
    autoHold: m.autoHold, autoHoldReason: m.autoHoldReason,
    warmupRepPct: m.warmupRepPct, warmupStatus: m.warmupStatus,
    createdAt: m.createdAt, updatedAt: m.updatedAt,
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
  /** Backdate the inbox (e.g. to its upstream warm-up start) so the cold-cap ramp
   *  reflects its TRUE age. Honored on insert only; updates keep the original. */
  createdAt?: string;
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
    // Empty stays empty: "" marks a credential-less mailbox (OAuth, sends upstream)
    // and the rotation skips it. Never encrypt an empty string into a truthy blob.
    smtpPassEnc: input.smtpPass ? encryptSecret(input.smtpPass) : "",
    imapHost: input.imapHost?.trim() || undefined,
    imapPort: input.imapHost ? normalizePort(input.imapPort, 993) : undefined,
    imapUser: input.imapHost ? (input.imapUser || input.email).trim() : undefined,
    imapPassEnc: input.imapHost && (input.imapPass || input.smtpPass) ? encryptSecret(input.imapPass || input.smtpPass || "") : undefined,
    dailyCap: COLD_PER_INBOX,   // stored stamp only; the EFFECTIVE cap is coldCapFor(m)'s warm-up ramp (limits.ts)
    sentToday: 0,
    status: input.status || "warming",
    warmExternal: input.warmExternal ?? true,
    sent: 0,
    bounced: 0,
    createdAt: input.createdAt && Number.isFinite(Date.parse(input.createdAt)) ? input.createdAt : now,
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
    // Carry the login-health record across a re-import. The hourly fleet sync
    // re-adds every mailbox, and rebuilding the row from scratch used to drop
    // both fields: the WHY behind a failing Email ID was erased within the hour
    // (Senders showed "N in error" with a blank Recent errors column), and the
    // auth sweep saw every mailbox as never-verified forever, so "N due a
    // re-check" could never settle. Status already survives a re-import; the
    // evidence for that status has to survive with it.
    m.lastError = prev.lastError;
    const prevVerify = (prev as unknown as { lastVerifyAt?: string }).lastVerifyAt;
    if (prevVerify) (m as unknown as { lastVerifyAt?: string }).lastVerifyAt = prevVerify;
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
      // An operator decision supersedes the guard: clear the auto-hold marker so
      // the guard treats this row as operator-managed, and give a manual revive
      // a clean bounce window (same as an auto bounce-back).
      m.autoHold = false;
      m.autoHoldReason = undefined;
      m.recoverStreak = 0;
      if (status !== "paused") { m.guardBaseSent = m.sent || 0; m.guardBaseBounced = m.bounced || 0; }
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
      p.dailyCapacity += coldCapFor(m);
      p.remainingToday += Math.max(0, coldCapFor(m) - m.sentToday);
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
      cap += coldCapFor(m);
      rem += Math.max(0, coldCapFor(m) - m.sentToday);
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

/**
 * Zero EVERY inbox's daily counter when the UTC day rolls over — and only then. Safe to call on
 * any cadence (each send, the 6-hourly tick): the persisted day stamp makes repeat calls within
 * a day no-ops, so caps are never re-opened mid-day, and a restart can't re-zero spent capacity.
 * This is the reset that actually runs in production (pickSender calls it) — without it every
 * pooled inbox permanently capped out after day one and all email fell through to MTA/Instantly.
 */
export async function resetDailyIfNewDay(): Promise<boolean> {
  await hydrate();
  const today = nowIso().slice(0, 10);
  if (state.lastResetDay === today) return false;
  state.lastResetDay = today;
  for (const m of state.inboxes) { if (m.sentToday !== 0) m.sentToday = 0; }
  save();
  return true;
}

/** Distinct portal (workspace) ids that own at least one sender inbox. */
export async function listSenderWorkspaceIds(): Promise<string[]> {
  await hydrate();
  return [...new Set(state.inboxes.map((m) => m.workspaceId))];
}

/* ---------------- capacity (hard limits, for the Send Queue) ---------------- */

function domainOf(email: string): string {
  const i = email.indexOf("@");
  return i >= 0 ? email.slice(i + 1).toLowerCase().trim() : "";
}

export interface RecruiterCapacity {
  ownerId: string;
  ownerName: string;
  inboxes: number;
  domains: number;
  coldCapacity: number;     // inboxes × COLD_PER_INBOX
  coldUsedToday: number;
  coldRemaining: number;
  warmingPerDay: number;    // inboxes × WARMING_PER_INBOX (Smartlead, informational)
}

/** Per-provider capacity rollup: Sending.ac's flat 2/day model versus the internal
 *  SMTP server's warm-up ramp are DIFFERENT products; capacity reads wrong unless
 *  they're split. `capModel` tells the UI which story to render. */
export interface ProviderCapacity {
  provider: string;                  // sending-ac | own-smtp | google | outlook | other
  capModel: "flat" | "ramp";
  inboxes: number;
  domains: number;
  coldCapacity: number;
  coldUsedToday: number;
  coldRemaining: number;
  matureCapacity: number;            // cold sends/day at FULL ramp (flat model: == coldCapacity)
}

export interface SendCapacity {
  coldPerInbox: number;
  warmingPerInbox: number;
  inboxesPerDomain: number;
  inboxes: number;
  domains: number;
  coldCapacity: number;
  coldUsedToday: number;
  coldRemaining: number;
  matureCapacity: number;            // portal-wide cold sends/day at FULL ramp
  warmingPerDay: number;
  byRecruiter: RecruiterCapacity[];
  byProvider: ProviderCapacity[];
}

/**
 * Daily cold-send capacity for a portal, enforcing the HARD per-inbox ramp (limits.ts):
 * every Email ID counts for at most its coldCapFor() warm-up-ramped sends/day.
 * `coldUsedToday` ticks up as the rotation records sends, so the Send Queue can show
 * the remaining headroom draining toward zero.
 */
export async function sendCapacity(workspaceId: string): Promise<SendCapacity> {
  await hydrate();
  const mine = state.inboxes.filter(
    (m) => m.workspaceId === workspaceId && (m.status === "active" || m.status === "warming"),
  );
  const recs = new Map<string, RecruiterCapacity & { _domains: Set<string> }>();
  const provs = new Map<string, ProviderCapacity & { _domains: Set<string> }>();
  const domains = new Set<string>();
  let inboxes = 0, coldCapacity = 0, coldUsedToday = 0, matureCapacity = 0;
  for (const m of mine) {
    const cap = coldCapFor(m);
    // Full-ramp ceiling for this inbox: Sending.ac is flat (never ramps), every
    // other provider matures to coldMaxPerInbox()/day. Lets the UI show the real
    // capacity (e.g. 1,500/day) next to today's warm-up-throttled figure.
    const mature = m.provider === "sending-ac" ? SENDING_AC_PER_INBOX : coldMaxPerInbox();
    const used = Math.min(m.sentToday, cap);
    const dom = domainOf(m.email);
    inboxes++; coldCapacity += cap; coldUsedToday += used; matureCapacity += mature;
    if (dom) domains.add(dom);
    const pKey = m.provider || "other";
    let pv = provs.get(pKey);
    if (!pv) {
      pv = {
        provider: pKey, capModel: pKey === "sending-ac" ? "flat" : "ramp",
        inboxes: 0, domains: 0, coldCapacity: 0, coldUsedToday: 0, coldRemaining: 0, matureCapacity: 0,
        _domains: new Set<string>(),
      };
      provs.set(pKey, pv);
    }
    pv.inboxes++; pv.coldCapacity += cap; pv.coldUsedToday += used; pv.matureCapacity += mature;
    if (dom) pv._domains.add(dom);
    const key = m.ownerId || "_unassigned";
    let r = recs.get(key);
    if (!r) {
      r = {
        ownerId: m.ownerId || "",
        ownerName: m.ownerName || (m.ownerId ? "(unknown)" : "Unassigned"),
        inboxes: 0, domains: 0, coldCapacity: 0, coldUsedToday: 0, coldRemaining: 0, warmingPerDay: 0,
        _domains: new Set<string>(),
      };
      recs.set(key, r);
    }
    r.inboxes++; r.coldCapacity += cap; r.coldUsedToday += used;
    if (dom) r._domains.add(dom);
  }
  const byRecruiter: RecruiterCapacity[] = [...recs.values()]
    .map((r) => ({
      ownerId: r.ownerId, ownerName: r.ownerName, inboxes: r.inboxes, domains: r._domains.size,
      coldCapacity: r.coldCapacity, coldUsedToday: r.coldUsedToday,
      coldRemaining: Math.max(0, r.coldCapacity - r.coldUsedToday),
      warmingPerDay: r.inboxes * WARMING_PER_INBOX,
    }))
    .sort((a, b) => b.inboxes - a.inboxes);
  const byProvider: ProviderCapacity[] = [...provs.values()]
    .map((p) => ({
      provider: p.provider, capModel: p.capModel, inboxes: p.inboxes, domains: p._domains.size,
      coldCapacity: p.coldCapacity, coldUsedToday: p.coldUsedToday,
      coldRemaining: Math.max(0, p.coldCapacity - p.coldUsedToday),
      matureCapacity: p.matureCapacity,
    }))
    .sort((a, b) => b.inboxes - a.inboxes);
  return {
    coldPerInbox: coldMaxPerInbox(), warmingPerInbox: WARMING_PER_INBOX, inboxesPerDomain: INBOXES_PER_DOMAIN,
    inboxes, domains: domains.size,
    coldCapacity, coldUsedToday, coldRemaining: Math.max(0, coldCapacity - coldUsedToday),
    matureCapacity,
    warmingPerDay: inboxes * WARMING_PER_INBOX,
    byRecruiter,
    byProvider,
  };
}

/**
 * Lowercased set of every pooled inbox's email domain, across ALL workspaces. Powers the
 * media-host cert gate (sending/mediaAsk.ts): vid.<domain> only gets a certificate when
 * <domain> is one we actually send from.
 */
export async function allInboxDomains(): Promise<Set<string>> {
  await hydrate();
  const out = new Set<string>();
  for (const m of state.inboxes) {
    const d = (m.email.split("@")[1] || "").trim().toLowerCase();
    if (d) out.add(d);
  }
  return out;
}
