/**
 * RecruitersOS · Phone Intelligence · Call queue (owner-initiated)
 *
 * The human-in-the-loop seam. The owner SELECTS the contacts to call and drops
 * them here; nothing dials until the owner deliberately starts the queue. This
 * is what keeps live calling a chosen action, not an autonomous trigger.
 *
 * Self-contained snapshot (phone_intel_queue_v1). Items are plain data —
 * enqueue/list/remove are pure CRUD; the dialing happens in processQueue(),
 * which the owner-gated start route invokes.
 */

import { rid, nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";

export interface QueueItem {
  id: string;
  workspaceId: string;
  companyName: string;
  domain?: string;
  mainPhone: string; // E.164, the company's published number
  first?: string;
  last?: string;
  full: string;
  title?: string;
  contactId?: string;
  location?: string;
  stateCode?: string;
  status: "queued" | "dialing" | "done" | "skipped";
  callId?: string;
  skipReason?: string;
  addedByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

const SNAP_KEY = "phone_intel_queue_v1";
const store = { items: [] as QueueItem[] };
const persist = debouncedSaver(SNAP_KEY, () => store);

let hydrated: Promise<void> | null = null;
export function ensureQueueReady(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled()
      ? loadSnapshot<any>(SNAP_KEY).then((s) => { if (s?.items) store.items = s.items; }).catch(() => {})
      : Promise.resolve();
  }
  return hydrated;
}
void ensureQueueReady();

export function enqueue(
  workspaceId: string,
  input: Omit<QueueItem, "id" | "workspaceId" | "status" | "createdAt" | "updatedAt">,
): QueueItem {
  const item: QueueItem = {
    ...input,
    id: rid("q"),
    workspaceId,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.items.push(item);
  persist();
  return item;
}

export function enqueueMany(
  workspaceId: string,
  inputs: Array<Omit<QueueItem, "id" | "workspaceId" | "status" | "createdAt" | "updatedAt">>,
): QueueItem[] {
  return inputs.map((i) => enqueue(workspaceId, i));
}

export function listQueue(workspaceId: string, status?: QueueItem["status"]): QueueItem[] {
  return store.items
    .filter((i) => i.workspaceId === workspaceId && (!status || i.status === status))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export function patchItem(workspaceId: string, id: string, patch: Partial<QueueItem>): QueueItem | undefined {
  const it = store.items.find((i) => i.workspaceId === workspaceId && i.id === id);
  if (!it) return undefined;
  const { id: _i, workspaceId: _w, createdAt: _c, ...safe } = patch as any;
  Object.assign(it, safe, { updatedAt: nowIso() });
  persist();
  return it;
}

export function removeItem(workspaceId: string, id: string): boolean {
  const n = store.items.length;
  store.items = store.items.filter((i) => !(i.workspaceId === workspaceId && i.id === id));
  const removed = store.items.length !== n;
  if (removed) persist();
  return removed;
}

export function clearQueue(workspaceId: string, status?: QueueItem["status"]): number {
  const before = store.items.length;
  store.items = store.items.filter(
    (i) => i.workspaceId !== workspaceId || (status ? i.status !== status : false),
  );
  const removed = before - store.items.length;
  if (removed) persist();
  return removed;
}
