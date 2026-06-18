/**
 * RecruitersOS · JD Sourcing
 * Staging store for saved sourcing runs.
 *
 * A SourcingRun is what the recruiter saves under a name in the JD Sourcing tab BEFORE
 * promoting it into Candidates — the review buffer. Held in memory for fast access and
 * snapshotted to the durable backend (ros_kv / file volume) so saved searches survive a
 * redeploy. Same hydrate-once / debounced-snapshot pattern as the companies store and the
 * data warehouse. Without this, every deploy restarts the process and wipes saved runs.
 */

import { rid, nowIso } from "../core/ids";
import { loadSnapshot, debouncedSaver } from "../db";
import type { CandidateRow, CandidateICP, SourcingQuery, SourcingRun } from "./types";
import type { Motion } from "../core/types";

const KEY = "sourcing_runs_v1";

let store: SourcingRun[] = [];
let hydrated = false;
let hydrating: Promise<void> | null = null;

const save = debouncedSaver(KEY, () => store);

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<SourcingRun[]>(KEY);
      if (Array.isArray(snap)) store = snap;
      hydrated = true;
    })();
  }
  return hydrating;
}

export async function listSourcingRuns(workspaceId: string): Promise<SourcingRun[]> {
  await hydrate();
  return store
    .filter((r) => r.workspaceId === workspaceId)
    .sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : 1));
}

export async function getSourcingRun(workspaceId: string, id: string): Promise<SourcingRun | undefined> {
  await hydrate();
  return store.find((r) => r.id === id && r.workspaceId === workspaceId);
}

export interface SaveRunInput {
  id?: string;
  name: string;
  motion?: Motion;
  jd: string;
  jdUrl?: string;
  location?: string;
  icp: CandidateICP;
  queries: SourcingQuery[];
  candidates: CandidateRow[];
  warnings?: string[];
}

/** Create or update a named run. Re-saving by id replaces its candidate set. */
export async function saveSourcingRun(workspaceId: string, input: SaveRunInput): Promise<SourcingRun> {
  await hydrate();
  const existing = input.id ? store.find((r) => r.id === input.id && r.workspaceId === workspaceId) : undefined;
  if (existing) {
    existing.name = input.name || existing.name;
    existing.jd = input.jd ?? existing.jd;
    existing.jdUrl = input.jdUrl ?? existing.jdUrl;
    existing.location = input.location ?? existing.location;
    existing.icp = input.icp ?? existing.icp;
    existing.queries = input.queries ?? existing.queries;
    existing.candidates = input.candidates ?? existing.candidates;
    if (input.warnings) existing.warnings = input.warnings;
    existing.updatedAt = nowIso();
    save();
    return existing;
  }
  const run: SourcingRun = {
    id: input.id || rid("srun"),
    workspaceId,
    name: input.name || "Untitled sourcing list",
    motion: input.motion ?? "recruiting",
    jd: input.jd || "",
    jdUrl: input.jdUrl,
    location: input.location,
    icp: input.icp,
    queries: input.queries || [],
    candidates: input.candidates || [],
    warnings: input.warnings || [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.push(run);
  save();
  return run;
}

export async function deleteSourcingRun(workspaceId: string, id: string): Promise<boolean> {
  await hydrate();
  const i = store.findIndex((r) => r.id === id && r.workspaceId === workspaceId);
  if (i < 0) return false;
  store.splice(i, 1);
  save();
  return true;
}

/** Hard-reset hook: drop every saved run for a workspace. */
export async function purgeWorkspaceSourcingRuns(workspaceId: string): Promise<number> {
  await hydrate();
  let n = 0;
  for (let i = store.length - 1; i >= 0; i--) {
    if (store[i].workspaceId === workspaceId) { store.splice(i, 1); n++; }
  }
  if (n) save();
  return n;
}
