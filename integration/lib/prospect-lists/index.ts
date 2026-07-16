/**
 * RecruitersOS · Prospect lists
 *
 * A named, saved set of prospects (an audience). Recruiters select prospects in
 * bulk under Prospects, save the selection as a named list, and later pull that
 * list up by name in a campaign (Campaign Studio) to assign it as the audience.
 *
 * Per-workspace in-memory reference store (swap for Prisma at the seam).
 */

import { rid, nowIso } from "../core/ids";
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

const store: ProspectList[] = [];

export function listProspectLists(workspaceId: string, motion?: Motion): ProspectList[] {
  return store
    .filter((l) => l.workspaceId === workspaceId && (!motion || !l.motion || l.motion === motion))
    .sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : 1));
}

export function getProspectList(workspaceId: string, id: string): ProspectList | undefined {
  return store.find((l) => l.id === id && l.workspaceId === workspaceId);
}

export interface ProspectListInput {
  id?: string;
  name: string;
  prospectIds: string[];
  dataIds?: string[];
  motion?: Motion;
}

export function upsertProspectList(workspaceId: string, input: ProspectListInput): ProspectList {
  const ids = Array.from(new Set((input.prospectIds || []).filter(Boolean)));
  const dataIds = Array.from(new Set((input.dataIds || []).filter(Boolean)));
  const existing = input.id ? getProspectList(workspaceId, input.id) : undefined;
  if (existing) {
    existing.name = input.name || existing.name;
    existing.prospectIds = ids;
    // Only replace dataIds when the caller sent them (older clients omit the field).
    if (input.dataIds) existing.dataIds = dataIds;
    if (input.motion) existing.motion = input.motion;
    existing.updatedAt = nowIso();
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
  return list;
}

export function deleteProspectList(workspaceId: string, id: string): boolean {
  const i = store.findIndex((l) => l.id === id && l.workspaceId === workspaceId);
  if (i < 0) return false;
  store.splice(i, 1);
  return true;
}

/** Hard-reset hook: drop every saved list for a workspace. */
export function purgeWorkspaceProspectLists(workspaceId: string): number {
  let n = 0;
  for (let i = store.length - 1; i >= 0; i--) {
    if (store[i].workspaceId === workspaceId) { store.splice(i, 1); n++; }
  }
  return n;
}
