/**
 * RecruitersOS · Candidates auto-seed (Lume-portal only)
 * The bundled Lume Search Partners export is Lume's OWN data — it must live ONLY
 * on the Lume white-label portal (app.lumesp.com / lumesp.com), never on the
 * RecruitersOS operator portal or any other tenant.
 *
 * So this module is host-gated:
 *   - On a Lume host  -> load the bundled export into the warehouse once, when it
 *     is empty (so the data is simply THERE without a manual import).
 *   - On any other host (RecruitersOS, other white-label tenants) -> actively
 *     REMOVE the bundled seed rows once (matched by their export ids), so a
 *     previously auto-seeded copy never lingers there. Never seed.
 *
 * Both passes are marker-guarded so they run at most once per workspace and never
 * fight a deliberate manual import or a deliberate purge.
 */

import { loadSnapshot, saveSnapshot } from "../db";
import { rowsToInputs } from "./import";
import { upsertRecords, deleteByProviderId, stats } from "./store";
import { LUME_ROWS } from "../dev/lume-records";
import { presetForHost } from "../branding/presets";

const SEED_MARKER = "data_lume_seeded_v1";
const UNSEED_MARKER = "data_lume_unseeded_v1";
const markers: Record<string, Set<string> | undefined> = {};

/** Export ids of the bundled rows — used to remove a stray seed off non-Lume portals. */
const LUME_SEED_IDS = LUME_ROWS.map((r) => r["Id"]).filter(Boolean) as string[];

async function markerSet(key: string): Promise<Set<string>> {
  if (!markers[key]) {
    const arr = await loadSnapshot<string[]>(key);
    markers[key] = new Set(Array.isArray(arr) ? arr : []);
  }
  return markers[key] as Set<string>;
}

/** Reduce a host header to a bare hostname and decide whether it is a Lume portal. */
function isLumeHost(host: string | undefined): boolean {
  const h = (host || "").toLowerCase().split(",")[0].trim().replace(/:\d+$/, "");
  return !!presetForHost(h);
}

/**
 * Keep the bundled Lume export confined to the Lume portal. `host` is the request
 * host (x-forwarded-host / host header) so we can tell which portal is loading.
 */
export async function ensureLumeSeed(workspaceId: string, host?: string): Promise<void> {
  try {
    if (isLumeHost(host)) {
      // Lume's own portal: load the export once, only when the warehouse is empty.
      const seeded = await markerSet(SEED_MARKER);
      if (seeded.has(workspaceId)) return;
      const s = await stats(workspaceId);
      if (!s.total) {
        await upsertRecords(workspaceId, rowsToInputs(LUME_ROWS, { source: "csv" }));
      }
      seeded.add(workspaceId);
      await saveSnapshot(SEED_MARKER, Array.from(seeded));
    } else {
      // Any other portal (RecruitersOS, other tenants): scrub a stray seed once.
      const unseeded = await markerSet(UNSEED_MARKER);
      if (unseeded.has(workspaceId)) return;
      for (const id of LUME_SEED_IDS) await deleteByProviderId(workspaceId, id);
      unseeded.add(workspaceId);
      await saveSnapshot(UNSEED_MARKER, Array.from(unseeded));
    }
  } catch {
    // Non-fatal: never let a seed/scrub hiccup break loading the Candidates list.
  }
}
