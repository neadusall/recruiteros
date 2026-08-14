/**
 * /api/owner/fleet-verify   (OWNER ONLY)
 *   GET -> the daily full-fleet verification: every sending domain and every mailbox with an
 *          explicit verdict (healthy / warning / unhealthy), the reasons when it is not
 *          healthy, and the concrete fix for each reason. Written daily (and on demand) by
 *          the host verifier to /data/snap_fleet_verify_v1.json; staleness included so a
 *          dead verifier shows as a red banner, never yesterday's board.
 */

import { readFileSync } from "node:fs";
import { requireOwner, ok } from "../../../../lib/api";

const SNAP = process.env.FLEET_VERIFY_FILE || "/data/snap_fleet_verify_v1.json";
const STALE_AFTER_MIN = 26 * 60; // daily cadence + slack

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  try {
    const snap = JSON.parse(readFileSync(SNAP, "utf8"));
    const ageMin = Math.round((Date.now() - Date.parse(snap.generatedAt || 0)) / 60000);
    return ok({ ...snap, ageMin, stale: !Number.isFinite(ageMin) || ageMin > STALE_AFTER_MIN });
  } catch {
    return ok({ missing: true, stale: true, ageMin: null, domainSummary: {}, mailboxSummary: {}, domains: [], mailboxes: [] });
  }
}
