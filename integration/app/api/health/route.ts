/**
 * GET /api/health -> liveness + a precise view of whether durable persistence is
 * actually wired in the RUNNING container. `ver` lets us confirm the backend
 * container actually rebuilt; the env flags show whether the persistence config
 * reached it (the fix for the "logged out / data wiped on every deploy" bug).
 */

import { dbEnabled, dbPing } from "../../../lib/db";
import { ok } from "../../../lib/api";

export async function GET() {
  return ok({
    ok: true,
    ver: "h4-filevol",                       // bump on deploy to confirm the container rebuilt
    db: dbEnabled(),
    dbConnected: await dbPing(),
    hasDataDir: !!process.env.ROS_DATA_DIR,  // file persistence configured?
    hasDbUrl: !!process.env.DATABASE_URL,    // explicit Postgres?
    hasPgPw: !!process.env.POSTGRES_PASSWORD,
  });
}
