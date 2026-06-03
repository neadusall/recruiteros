/**
 * RecruiterOS · JD Sourcing
 * Staging store for saved sourcing runs.
 *
 * A SourcingRun is what the recruiter saves under a name in the JD Sourcing tab BEFORE
 * promoting it into Candidates — the review buffer. Per-workspace in-memory reference
 * store, same pattern as prospect-lists (swap for Prisma at the seam).
 */

import { rid, nowIso } from "../core/ids";
import type { CandidateRow, CandidateICP, SourcingQuery, SourcingRun } from "./types";
import type { Motion } from "../core/types";

const store: SourcingRun[] = [];

export function listSourcingRuns(workspaceId: string): SourcingRun[] {
  return store
    .filter((r) => r.workspaceId === workspaceId)
    .sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : 1));
}

export function getSourcingRun(workspaceId: string, id: string): SourcingRun | undefined {
  return store.find((r) => r.id === id && r.workspaceId === workspaceId);
}

export interface SaveRunInput {
  id?: string;
  name: string;
  motion?: Motion;
  jd: string;
  jdUrl?: string;
  icp: CandidateICP;
  queries: SourcingQuery[];
  candidates: CandidateRow[];
  warnings?: string[];
}

/** Create or update a named run. Re-saving by id replaces its candidate set. */
export function saveSourcingRun(workspaceId: string, input: SaveRunInput): SourcingRun {
  const existing = input.id ? getSourcingRun(workspaceId, input.id) : undefined;
  if (existing) {
    existing.name = input.name || existing.name;
    existing.jd = input.jd ?? existing.jd;
    existing.jdUrl = input.jdUrl ?? existing.jdUrl;
    existing.icp = input.icp ?? existing.icp;
    existing.queries = input.queries ?? existing.queries;
    existing.candidates = input.candidates ?? existing.candidates;
    if (input.warnings) existing.warnings = input.warnings;
    existing.updatedAt = nowIso();
    return existing;
  }
  const run: SourcingRun = {
    id: input.id || rid("srun"),
    workspaceId,
    name: input.name || "Untitled sourcing list",
    motion: input.motion ?? "recruiting",
    jd: input.jd || "",
    jdUrl: input.jdUrl,
    icp: input.icp,
    queries: input.queries || [],
    candidates: input.candidates || [],
    warnings: input.warnings || [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.push(run);
  return run;
}

export function deleteSourcingRun(workspaceId: string, id: string): boolean {
  const i = store.findIndex((r) => r.id === id && r.workspaceId === workspaceId);
  if (i < 0) return false;
  store.splice(i, 1);
  return true;
}

/** Hard-reset hook: drop every saved run for a workspace. */
export function purgeWorkspaceSourcingRuns(workspaceId: string): number {
  let n = 0;
  for (let i = store.length - 1; i >= 0; i--) {
    if (store[i].workspaceId === workspaceId) { store.splice(i, 1); n++; }
  }
  return n;
}
