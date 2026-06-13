/**
 * RecruitersOS · Import motion
 *
 * Per-workspace "where do LinkedIn scrapes land" preference. The portal writes
 * it whenever the user toggles Recruiting/BD; the Chrome extension's ingest
 * (campaignFromDataset) reads it so scraped leads drop into the active motion's
 * bucket — not a fixed one. Persisted via the durable snapshot layer.
 */

import { loadSnapshot, debouncedSaver, dbEnabled } from "../db";
import type { Motion } from "../core/types";

const map = new Map<string, Motion>();
const persist = debouncedSaver("import-motion", () => [...map.entries()]);

let hydrated: Promise<void> | null = null;
function ready(): Promise<void> {
  if (!hydrated) {
    hydrated = dbEnabled()
      ? loadSnapshot<[string, Motion][]>("import-motion")
          .then((rows) => { for (const [w, m] of rows ?? []) map.set(w, m); })
          .catch(() => {})
      : Promise.resolve();
  }
  return hydrated;
}

export async function getImportMotion(workspaceId: string): Promise<Motion> {
  await ready();
  return map.get(workspaceId) || "recruiting";
}

export async function setImportMotion(workspaceId: string, motion: Motion): Promise<Motion> {
  await ready();
  const m: Motion = motion === "bd" ? "bd" : "recruiting";
  map.set(workspaceId, m);
  persist();
  return m;
}
