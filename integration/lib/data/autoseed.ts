/**
 * RecruitersOS · Candidates auto-seed
 * On first open of the Candidates tab, load the bundled Lume Search Partners
 * export into the workspace's warehouse — so the data is simply THERE without a
 * manual import step. Runs at most once per workspace (persisted marker) and
 * ONLY when that warehouse is empty, so it never clobbers real imported data and
 * never comes back after a deliberate purge.
 */

import { loadSnapshot, saveSnapshot } from "../db";
import { rowsToInputs } from "./import";
import { upsertRecords, stats } from "./store";
import { LUME_ROWS } from "../dev/lume-records";

const MARKER = "data_lume_seeded_v1";
let seeded: Set<string> | null = null;

async function markerSet(): Promise<Set<string>> {
  if (!seeded) {
    const arr = await loadSnapshot<string[]>(MARKER);
    seeded = new Set(Array.isArray(arr) ? arr : []);
  }
  return seeded;
}

/** Idempotently ensure the Lume export is loaded for a fresh workspace. */
export async function ensureLumeSeed(workspaceId: string): Promise<void> {
  const mark = await markerSet();
  if (mark.has(workspaceId)) return;
  try {
    const s = await stats(workspaceId);
    if (!s.total) {
      await upsertRecords(workspaceId, rowsToInputs(LUME_ROWS, { source: "csv" }));
    }
    mark.add(workspaceId);
    await saveSnapshot(MARKER, Array.from(mark));
  } catch {
    // Non-fatal: never let a seed hiccup break loading the Candidates list.
  }
}
