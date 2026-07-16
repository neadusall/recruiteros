/**
 * RecruitersOS · Data warehouse store
 *
 * Workspace-scoped table of DataRecords, held in memory for fast search and
 * snapshotted to the durable backend (ros_kv / file volume) so the warehouse
 * survives a redeploy — this is the user's database, it must persist.
 *
 * Same shape as inmarket/pool.ts: hydrate once on first touch, mutate the
 * in-memory array, debounce a single snapshot write. One blob holds every
 * workspace's records; reads filter by workspaceId.
 */

import { rid, nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver } from "../db";
import type { DataRecord, DataRecordInput, DataQuery } from "./types";

const KEY = "data_warehouse_v1";

let store: DataRecord[] = [];
let hydrated = false;
let hydrating: Promise<void> | null = null;

const save = debouncedSaver(KEY, () => store);

/** Load the snapshot into memory exactly once (idempotent, concurrency-safe). */
async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<DataRecord[]>(KEY);
      if (Array.isArray(snap)) store = snap;
      hydrated = true;
    })();
  }
  return hydrating;
}

/** Stable de-dupe key: provider id → linkedin → email → name+company. */
function dedupeKey(r: { providerId?: string; linkedinUrl?: string; email?: string; fullName?: string; company?: string }): string {
  if (r.providerId) return "pid:" + r.providerId.toLowerCase().trim();
  if (r.linkedinUrl) return "li:" + r.linkedinUrl.toLowerCase().replace(/\/+$/, "").trim();
  if (r.email) return "em:" + r.email.toLowerCase().trim();
  return "nc:" + ((r.fullName || "") + "|" + (r.company || "")).toLowerCase().trim();
}

/** Merge non-empty fields from `next` onto `prev` (incoming wins, but never blanks). */
function mergeInto(prev: DataRecord, next: DataRecordInput): DataRecord {
  for (const [k, v] of Object.entries(next)) {
    if (k === "raw") continue;
    if (v !== undefined && v !== null && v !== "") (prev as unknown as Record<string, unknown>)[k] = v;
  }
  if (next.raw) prev.raw = { ...(prev.raw || {}), ...next.raw };
  prev.updatedAt = nowIso();
  return prev;
}

export async function listRecords(workspaceId: string, q: DataQuery = {}): Promise<{ records: DataRecord[]; total: number }> {
  await hydrate();
  const term = (q.q || "").toLowerCase().trim();
  const company = (q.company || "").toLowerCase().trim();
  let rows = store.filter((r) => r.workspaceId === workspaceId);

  if (term) {
    rows = rows.filter((r) =>
      (r.fullName + " " + (r.title || "") + " " + (r.company || "") + " " + (r.email || "") + " " + (r.tags || []).join(" ")).toLowerCase().includes(term),
    );
  }
  if (company) rows = rows.filter((r) => (r.company || "").toLowerCase().includes(company));
  if (q.hasEmail) rows = rows.filter((r) => !!r.email);
  if (q.hasPhone) rows = rows.filter((r) => !!(r.phone || r.directPhone));
  if (q.source) rows = rows.filter((r) => r.source === q.source);

  rows.sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : 1));
  const total = rows.length;
  const offset = q.offset || 0;
  const limit = q.limit ?? 100;
  return { records: rows.slice(offset, offset + limit), total };
}

export async function getRecord(workspaceId: string, id: string): Promise<DataRecord | undefined> {
  await hydrate();
  return store.find((r) => r.id === id && r.workspaceId === workspaceId);
}

/**
 * Upsert a batch by de-dupe key. New keys are inserted; existing ones get their
 * empty fields filled (incoming non-empty values win). Returns the tallies the
 * importer surfaces to the user. One debounced save covers the whole batch.
 */
export async function upsertRecords(
  workspaceId: string,
  inputs: DataRecordInput[],
): Promise<{ added: number; updated: number; records: DataRecord[] }> {
  await hydrate();
  const index = new Map<string, DataRecord>();
  for (const r of store) if (r.workspaceId === workspaceId) index.set(dedupeKey(r), r);

  let added = 0;
  let updated = 0;
  const touched: DataRecord[] = [];
  for (const input of inputs) {
    if (!input.fullName) continue;
    const k = dedupeKey(input);
    const existing = index.get(k);
    if (existing) {
      mergeInto(existing, input);
      updated++;
      touched.push(existing);
    } else {
      const now = nowIso();
      const rec: DataRecord = { id: rid("data"), workspaceId, createdAt: now, updatedAt: now, ...input };
      store.push(rec);
      index.set(k, rec);
      added++;
      touched.push(rec);
    }
  }
  if (added || updated) save();
  return { added, updated, records: touched };
}

/** Persist an in-place mutation to a single record (e.g. after enrichment). */
export async function saveRecord(rec: DataRecord): Promise<void> {
  await hydrate();
  rec.updatedAt = nowIso();
  if (!store.includes(rec)) store.push(rec);
  save();
}

/**
 * Best-effort match for backfilling a lead: find a stored record for this person
 * by linkedin → email → phone → name+company. Read-only; used by campaign
 * enrichment and the contact guard before spending on a paid lookup / a send.
 */
export async function findRecordForPerson(
  workspaceId: string,
  who: { linkedinUrl?: string; email?: string; phone?: string; fullName?: string; company?: string },
): Promise<DataRecord | undefined> {
  await hydrate();
  const rows = store.filter((r) => r.workspaceId === workspaceId);
  const li = who.linkedinUrl?.toLowerCase().replace(/\/+$/, "").trim();
  if (li) { const m = rows.find((r) => r.linkedinUrl?.toLowerCase().replace(/\/+$/, "").trim() === li); if (m) return m; }
  const em = who.email?.toLowerCase().trim();
  if (em) { const m = rows.find((r) => (r.email?.toLowerCase().trim() === em) || (r.email2?.toLowerCase().trim() === em)); if (m) return m; }
  const ph = phoneKey(who.phone);
  if (ph) { const m = rows.find((r) => phoneKey(r.phone) === ph || phoneKey(r.directPhone) === ph); if (m) return m; }
  const name = who.fullName?.toLowerCase().trim();
  const co = who.company?.toLowerCase().trim();
  if (name) return rows.find((r) => r.fullName.toLowerCase().trim() === name && (!co || (r.company || "").toLowerCase().trim() === co));
  return undefined;
}

/** Digits-only phone key (last 10) so formatting differences still match. */
function phoneKey(v?: string): string {
  const d = (v || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}

/**
 * Stamp communication state (from the ATS activity sync or our own sends) onto
 * records, keyed by the provider's person id. Only ever moves `lastContactedAt`
 * FORWARD, so replaying an activity window can't erase a newer touch.
 * Returns how many records changed; one debounced save covers the batch.
 */
export async function applyContactActivity(
  workspaceId: string,
  updates: Map<string, { at: string; channel?: string; doNotContact?: boolean; dncReason?: string }>,
): Promise<number> {
  if (!updates.size) return 0;
  await hydrate();
  let n = 0;
  for (const r of store) {
    if (r.workspaceId !== workspaceId || !r.providerId) continue;
    const u = updates.get(String(r.providerId));
    if (!u) continue;
    let changed = false;
    if (u.at && (!r.lastContactedAt || u.at > r.lastContactedAt)) {
      r.lastContactedAt = u.at;
      if (u.channel) r.lastContactChannel = u.channel;
      changed = true;
    }
    if (u.doNotContact && !r.doNotContact) {
      r.doNotContact = true;
      r.dncReason = u.dncReason || "ats";
      changed = true;
    }
    if (changed) { r.updatedAt = nowIso(); n++; }
  }
  if (n) save();
  return n;
}

export async function deleteRecords(workspaceId: string, ids: string[]): Promise<number> {
  await hydrate();
  const set = new Set(ids);
  let n = 0;
  for (let i = store.length - 1; i >= 0; i--) {
    if (store[i].workspaceId === workspaceId && set.has(store[i].id)) { store.splice(i, 1); n++; }
  }
  if (n) save();
  return n;
}

/** Delete by the source system's own id — used when a Loxo `destroy` arrives. */
export async function deleteByProviderId(workspaceId: string, providerId: string): Promise<number> {
  await hydrate();
  const pid = String(providerId);
  let n = 0;
  for (let i = store.length - 1; i >= 0; i--) {
    if (store[i].workspaceId === workspaceId && store[i].providerId === pid) { store.splice(i, 1); n++; }
  }
  if (n) save();
  return n;
}

/** Counts for the Data tab header. */
export async function stats(workspaceId: string): Promise<{ total: number; withEmail: number; withPhone: number; bySource: Record<string, number> }> {
  await hydrate();
  const rows = store.filter((r) => r.workspaceId === workspaceId);
  const bySource: Record<string, number> = {};
  let withEmail = 0;
  let withPhone = 0;
  for (const r of rows) {
    bySource[r.source] = (bySource[r.source] || 0) + 1;
    if (r.email) withEmail++;
    if (r.phone || r.directPhone) withPhone++;
  }
  return { total: rows.length, withEmail, withPhone, bySource };
}

/** Hard-reset hook: drop every record for a workspace. */
export async function purgeWorkspaceData(workspaceId: string): Promise<number> {
  await hydrate();
  let n = 0;
  for (let i = store.length - 1; i >= 0; i--) {
    if (store[i].workspaceId === workspaceId) { store.splice(i, 1); n++; }
  }
  if (n) save();
  return n;
}
