/**
 * GET  /api/prospects        -> pipeline list (+ lifecycle labels)
 * POST /api/prospects        -> add one prospect (upserts the ATS Person)
 *   { action: "bulk", rows } -> CSV bulk upload with dedupe
 *   { action: "transition", prospectId, status } -> move lifecycle stage
 */

import { getCore } from "../../../lib/core/repository";
import { addProspect, bulkUpload, transition, LIFECYCLE, type NewProspectInput } from "../../../lib/prospects";
import { requireSession, body, ok, fail } from "../../../lib/api";
import type { ProspectStatus } from "../../../lib/core/types";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  const campaignId = url.searchParams.get("campaign") ?? undefined;
  const status = (url.searchParams.get("status") as ProspectStatus | null) ?? undefined;
  const prospects = await getCore().listProspects(g.ctx.workspace.id, { campaignId, status });
  return ok({ prospects, lifecycle: LIFECYCLE });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);

  if (b?.action === "bulk" && Array.isArray(b.rows)) {
    const rows: NewProspectInput[] = b.rows.map((r: any) => ({ ...r, workspaceId: ws }));
    return ok(await bulkUpload(rows));
  }
  if (b?.action === "transition") {
    if (!b.prospectId || !b.status) return fail("missing_fields", 422);
    const p = await transition(b.prospectId, b.status);
    return p ? ok({ prospect: p }) : fail("not_found", 404);
  }
  if (!b?.fullName || !b?.campaignId) return fail("missing_fields", 422);
  const p = await addProspect({ ...b, workspaceId: ws });
  return ok({ prospect: p }, 201);
}
