/**
 * GET /api/health -> liveness + a precise view of whether durable persistence is
 * actually wired in the RUNNING container. `ver` lets us confirm the backend
 * container actually rebuilt; the env flags show whether the persistence config
 * reached it (the fix for the "logged out / data wiped on every deploy" bug).
 */

import { statSync, readFileSync } from "fs";
import { dbEnabled, dbPing } from "../../../lib/db";
import { ok } from "../../../lib/api";

/**
 * Two independent reads on whether /data is durable:
 *  - dataDirMounted: /data on a different device than "/" (named volume).
 *  - dataDirIsMountpoint: /data appears as its own line in the kernel's
 *    mountinfo — the authoritative "is this a mount point" answer, robust to
 *    storage drivers where a bind/volume can share a device number with root.
 * If EITHER is true, writes to /data survive a container rebuild.
 */
function dataDirMounted(): boolean {
  try {
    return statSync("/data").dev !== statSync("/").dev;
  } catch {
    return false;
  }
}
function dataDirIsMountpoint(): boolean {
  try {
    const mi = readFileSync("/proc/self/mountinfo", "utf8");
    return mi.split("\n").some((l) => {
      const mp = l.split(" ")[4]; // 5th field = mount point
      return mp === "/data" || mp?.startsWith("/data/");
    });
  } catch {
    return false;
  }
}

export async function GET() {
  return ok({
    ok: true,
    ver: "h6-mountinfo",                     // bump on deploy to confirm the container rebuilt
    db: dbEnabled(),
    dbConnected: await dbPing(),
    dataDirMounted: dataDirMounted(),        // device-diff heuristic
    dataDirIsMountpoint: dataDirIsMountpoint(), // authoritative kernel mountinfo
    hasDataDir: !!process.env.ROS_DATA_DIR,  // file persistence configured?
    hasDbUrl: !!process.env.DATABASE_URL,    // explicit Postgres?
    hasPgPw: !!process.env.POSTGRES_PASSWORD,
  });
}
