/**
 * RecruitersOS · Prospect lists
 *
 * A named, saved set of prospects (an audience). Recruiters select prospects in
 * bulk under Prospects, save the selection as a named list, and later pull that
 * list up by name in a campaign (Campaign Studio) to assign it as the audience.
 *
 * DURABLE since 2026-07-16: held in memory for fast access and snapshotted to
 * the durable backend (ros_kv / file volume), same hydrate-once pattern as the
 * sourcing-runs store. Before this the store was a plain in-process array, so
 * EVERY redeploy (the watcher redeploys on each push to main) silently wiped
 * every saved list grouping: JD Sourcing's "Send to Candidates" lists, the
 * unified Candidates tab's saved lists, campaign audiences. The prospects
 * themselves survived (core repository snapshots); only the lists vanished.
 *
 * Saves are awaited, not debounced: saving a list is an explicit, infrequent,
 * high-value action, and an awaited snapshot guarantees it is durable before
 * the API returns. saveSnapshot no-ops cleanly when persistence is disabled.
 */

import { rid, nowIso } from "../core/ids";
import { loadSnapshot, saveSnapshot } from "../db";
import type { Motion } from "../core/types";

export interface ProspectList {
  id: string;
  workspaceId: string;
  name: string;
  prospectIds: string[];
  /** Candidates data-warehouse record ids: the unified Candidates tab saves mixed lists. */
  dataIds?: string[];
  motion?: Motion;
  createdAt: string;
  updatedAt: string;
}

const KEY = "prospect_lists_v1";

let store: ProspectList[] = [];
let hydrated = false;
let hydrating: Promise<void> | null = null;

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<ProspectList[]>(KEY);
      if (Array.isArray(snap)) store = snap;
      hydrated = true;
    })();
  }
  return hydrating;
}

async function save(): Promise<void> {
  await saveSnapshot(KEY, store);
}

export async function listProspectLists(workspaceId: string, motion?: Motion): Promise<ProspectList[]> {
  await hydrate();
  return store
    .filter((l) => l.workspaceId === workspaceId && (!motion || !l.motion || l.motion === motion))
    .sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : 1));
}

export async function getProspectList(workspaceId: string, id: string): Promise<ProspectList | undefined> {
  await hydrate();
  return store.find((l) => l.id === id && l.workspaceId === workspaceId);
}

export interface ProspectListInput {
  id?: string;
  name: string;
  prospectIds: string[];
  dataIds?: string[];
  motion?: Motion;
}

export async function upsertProspectList(workspaceId: string, input: ProspectListInput): Promise<ProspectList> {
  await hydrate();
  const ids = Array.from(new Set((input.prospectIds || []).filter(Boolean)));
  const dataIds = Array.from(new Set((input.dataIds || []).filter(Boolean)));
  const existing = input.id ? store.find((l) => l.id === input.id && l.workspaceId === workspaceId) : undefined;
  if (existing) {
    existing.name = input.name || existing.name;
    existing.prospectIds = ids;
    // Only replace dataIds when the caller sent them (older clients omit the field).
    if (input.dataIds) existing.dataIds = dataIds;
    if (input.motion) existing.motion = input.motion;
    existing.updatedAt = nowIso();
    await save();
    return existing;
  }
  const list: ProspectList = {
    id: input.id || rid("plist"),
    workspaceId,
    name: input.name || "Untitled list",
    prospectIds: ids,
    dataIds: dataIds.length ? dataIds : undefined,
    motion: input.motion,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.push(list);
  await save();
  return list;
}

export async function deleteProspectList(workspaceId: string, id: string): Promise<boolean> {
  await hydrate();
  const i = store.findIndex((l) => l.id === id && l.workspaceId === workspaceId);
  if (i < 0) return false;
  store.splice(i, 1);
  await save();
  return true;
}

/** Hard-reset hook: drop every saved list for a workspace. */
export async function purgeWorkspaceProspectLists(workspaceId: string): Promise<number> {
  await hydrate();
  let n = 0;
  for (let i = store.length - 1; i >= 0; i--) {
    if (store[i].workspaceId === workspaceId) { store.splice(i, 1); n++; }
  }
  if (n) await save();
  return n;
}
