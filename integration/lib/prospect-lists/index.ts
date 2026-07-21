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

/** Group key for the one-list-per-name invariant: same workspace, same motion
 *  ("" when unset), same trimmed case-folded name. */
const nameKey = (l: { workspaceId: string; motion?: Motion; name: string }) =>
  `${l.workspaceId}|${l.motion || ""}|${(l.name || "").trim().toLowerCase()}`;

export async function upsertProspectList(workspaceId: string, input: ProspectListInput): Promise<ProspectList> {
  await hydrate();
  const ids = Array.from(new Set((input.prospectIds || []).filter(Boolean)));
  const dataIds = Array.from(new Set((input.dataIds || []).filter(Boolean)));
  let existing = input.id ? store.find((l) => l.id === input.id && l.workspaceId === workspaceId) : undefined;
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
  // NO-DUPLICATE INVARIANT (user mandate 2026-07-21): an id-less save that
  // matches an existing list by name UPDATES that list instead of minting a
  // sibling — same rule the OS Text engine applies to campaigns and the Sales
  // Nav merge applies to runs ("a reused name can never spawn a duplicate").
  // Members are UNIONED, not replaced: a name collision must never silently
  // drop people someone saved earlier (the newest of several same-name lists
  // wins the match; the sweeper's dedupe pass converges the rest).
  if (!input.id) {
    const key = nameKey({ workspaceId, motion: input.motion, name: input.name || "" });
    existing = store
      .filter((l) => l.workspaceId === workspaceId && nameKey(l) === key)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    if (existing) {
      existing.prospectIds = Array.from(new Set([...existing.prospectIds, ...ids]));
      if (dataIds.length) existing.dataIds = Array.from(new Set([...(existing.dataIds || []), ...dataIds]));
      existing.updatedAt = nowIso();
      await save();
      return existing;
    }
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

/* --- Self-healing duplicate fold -------------------------------------------
 * THE GUARANTEE (user mandate 2026-07-21: "no duplicates ever"): even if some
 * path slips a same-name sibling in (old clients, a race, restored backups),
 * the autoflow sweeper folds it away within minutes. Pure planner exported for
 * the regression suite; dedupeProspectLists applies it through the store so
 * every fold persists correctly under the running app.
 */

export interface ListFoldPlan {
  /** Surviving list id. */
  winnerId: string;
  /** Same-name lists folded into the winner (deleted after their members merge). */
  loserIds: string[];
  /** The winner's member sets after the fold (union across the group). */
  prospectIds: string[];
  dataIds: string[];
}

/**
 * Decide which same-name lists fold into which. Rules:
 *   - groups = same workspace + motion + trimmed case-folded name;
 *   - the winner is the newest REFERENCED list (a sourcing run's promotedListId
 *     points at it), else simply the newest;
 *   - referenced lists are NEVER deleted — deleting one would dangle its run's
 *     stamp, and the next top-up would re-create the list under that id (churn
 *     forever). If two runs reference two same-name lists, both stay; the
 *     same-role auto-combine folds the RUNS first and this pass mops up after.
 *   - members are unioned so a fold can never lose a saved person.
 */
export function planListDedupe(lists: ProspectList[], referencedIds: Set<string>): ListFoldPlan[] {
  const groups = new Map<string, ProspectList[]>();
  for (const l of lists) {
    const k = nameKey(l);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(l);
  }
  const plans: ListFoldPlan[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const newestFirst = [...group].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const winner = newestFirst.find((l) => referencedIds.has(l.id)) || newestFirst[0];
    const losers = newestFirst.filter((l) => l.id !== winner.id && !referencedIds.has(l.id));
    if (!losers.length) continue;
    const prospectIds = new Set(winner.prospectIds);
    const dataIds = new Set(winner.dataIds || []);
    for (const l of losers) {
      for (const id of l.prospectIds) prospectIds.add(id);
      for (const id of l.dataIds || []) dataIds.add(id);
    }
    plans.push({
      winnerId: winner.id,
      loserIds: losers.map((l) => l.id),
      prospectIds: [...prospectIds],
      dataIds: [...dataIds],
    });
  }
  return plans;
}

/** Fold every duplicate group in the store. Returns how many lists were folded
 *  away. maxFolds bounds one call's work (a big backlog drains over passes). */
export async function dedupeProspectLists(referencedIds: Set<string>, maxFolds = 40): Promise<number> {
  await hydrate();
  const plans = planListDedupe(store, referencedIds);
  let folded = 0;
  for (const plan of plans) {
    if (folded >= maxFolds) break;
    const winner = store.find((l) => l.id === plan.winnerId);
    if (!winner) continue;
    winner.prospectIds = plan.prospectIds;
    if (plan.dataIds.length) winner.dataIds = plan.dataIds;
    winner.updatedAt = nowIso();
    for (const id of plan.loserIds) {
      const i = store.findIndex((l) => l.id === id);
      if (i >= 0) { store.splice(i, 1); folded++; }
    }
  }
  if (folded) await save();
  return folded;
}

/** Every list across every workspace (background sweeps). */
export async function listAllProspectLists(): Promise<ProspectList[]> {
  await hydrate();
  return [...store];
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
