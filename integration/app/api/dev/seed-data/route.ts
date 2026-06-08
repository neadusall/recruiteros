/**
 * POST /api/dev/seed-data -> load the bundled Lume Search Partners people-export
 * into the signed-in workspace's Data warehouse. Runs the raw rows through the
 * SAME importer as a manual upload, so the result is identical to clicking
 * "Import export" with the CSV. Idempotent: re-running upserts (no duplicates).
 */

import { requireSession, ok } from "../../../../lib/api";
import { rowsToInputs, upsertRecords } from "../../../../lib/data";
import { LUME_ROWS } from "../../../../lib/dev/lume-records";

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const inputs = rowsToInputs(LUME_ROWS, { source: "csv" });
  const res = await upsertRecords(g.ctx.workspace.id, inputs);
  return ok({ added: res.added, updated: res.updated, total: res.added + res.updated });
}
