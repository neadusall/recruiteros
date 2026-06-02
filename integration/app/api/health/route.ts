/**
 * GET /api/health -> liveness + whether durable persistence is actually working.
 *   { ok, db, dbConnected }  — db: a connection string is configured;
 *   dbConnected: a real query succeeded. If db is true but dbConnected is false,
 *   accounts/sessions will NOT survive a redeploy (fix the DB before relying on it).
 */

import { dbEnabled, dbPing } from "../../../lib/db";
import { ok } from "../../../lib/api";

export async function GET() {
  return ok({ ok: true, db: dbEnabled(), dbConnected: await dbPing() });
}
