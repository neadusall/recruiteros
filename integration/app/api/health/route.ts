/**
 * GET /api/health -> liveness + a precise view of whether durable persistence is
 * actually wired in the RUNNING container. `ver` lets us confirm the backend
 * container actually rebuilt; the env flags show whether the persistence config
 * reached it (the fix for the "logged out / data wiped on every deploy" bug).
 */

import { statSync } from "fs";
import { dbEnabled, dbPing } from "../../../lib/db";
import { ok } from "../../../lib/api";

/**
 * Is /data a real persistent mount (the app_data named volume) rather than the
 * container's ephemeral writable layer? If /data sits on a DIFFERENT device than
 * "/", it's a separate mount = the durable volume. Same device = ephemeral, and
 * accounts written there are wiped on the next container rebuild. This is the
 * single fact that decides whether logins survive a deploy.
 */
function dataDirMounted(): boolean {
  try {
    return statSync("/data").dev !== statSync("/").dev;
  } catch {
    return false;
  }
}

export async function GET() {
  return ok({
    ok: true,
    ver: "h5-filevol-mountcheck",            // bump on deploy to confirm the container rebuilt
    db: dbEnabled(),
    dbConnected: await dbPing(),
    dataDirMounted: dataDirMounted(),        // TRUE = durable across redeploys; FALSE = ephemeral
    hasDataDir: !!process.env.ROS_DATA_DIR,  // file persistence configured?
    hasDbUrl: !!process.env.DATABASE_URL,    // explicit Postgres?
    hasPgPw: !!process.env.POSTGRES_PASSWORD,
  });
}
