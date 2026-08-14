/**
 * /api/owner/system-health   (OWNER ONLY)
 *   GET -> the full checks-and-balances snapshot the host collector writes every 15 minutes
 *          (/data/snap_system_health_v1.json), plus staleness so the UI can flag a dead
 *          collector. Every subsystem — sending, domains, supply pipeline, watchers, API
 *          credits — reports an explicit good/amber/bad reading here; the Owner Console
 *          Health tab renders it at a glance.
 *
 * The staleness field is the watcher-of-watchers: if the collector timer dies, generatedAt
 * ages and the UI shows a red banner instead of yesterday's green board.
 */

import { readFileSync } from "node:fs";
import { requireOwner, ok } from "../../../../lib/api";

const SNAP = process.env.SYSTEM_HEALTH_FILE || "/data/snap_system_health_v1.json";
const STALE_AFTER_MIN = 30;

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  try {
    const snap = JSON.parse(readFileSync(SNAP, "utf8"));
    const ageMin = Math.round((Date.now() - Date.parse(snap.generatedAt || 0)) / 60000);
    return ok({ ...snap, ageMin, stale: !Number.isFinite(ageMin) || ageMin > STALE_AFTER_MIN });
  } catch {
    return ok({ missing: true, stale: true, ageMin: null, summary: { good: 0, amber: 0, bad: 0 }, groups: [], checks: [] });
  }
}
