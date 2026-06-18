/**
 * RecruitersOS · JD Sourcing
 * Cross-run "seen" memory — the candidate keys a workspace has already surfaced.
 *
 * Persisted to the durable snapshot layer (same pattern as the run store) so re-running a
 * JD next week can show FRESH people (new market entrants) instead of the same 200. Keys
 * are candidateKey() values (LinkedIn URL, else name+company). Per-workspace, FIFO-capped
 * so the set can't grow without bound.
 */

import { loadSnapshot, saveSnapshot } from "../db";

const KEY = "sourcing_seen_v1";
const MAX_PER_WS = 200_000; // oldest keys are trimmed past this ceiling

type SeenStore = Record<string, string[]>; // workspaceId -> keys, oldest first

let store: SeenStore = {};
let hydrated = false;
let hydrating: Promise<void> | null = null;

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) {
    hydrating = (async () => {
      const snap = await loadSnapshot<SeenStore>(KEY);
      if (snap && typeof snap === "object") store = snap;
      hydrated = true;
    })();
  }
  return hydrating;
}

/** The set of keys already surfaced for this workspace (for fresh-only exclusion). */
export async function getSeenKeys(workspaceId: string): Promise<Set<string>> {
  await hydrate();
  return new Set(store[workspaceId] || []);
}

/** Record newly-surfaced keys for this workspace; no-op for keys already known. */
export async function addSeenKeys(workspaceId: string, keys: string[]): Promise<void> {
  await hydrate();
  if (!keys.length) return;
  const list = store[workspaceId] || [];
  const set = new Set(list);
  let changed = false;
  for (const k of keys) {
    if (k && !set.has(k)) { set.add(k); list.push(k); changed = true; }
  }
  if (!changed) return;
  if (list.length > MAX_PER_WS) list.splice(0, list.length - MAX_PER_WS); // FIFO trim
  store[workspaceId] = list;
  await saveSnapshot(KEY, store);
}
