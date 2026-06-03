/**
 * GET  /api/prospects        -> pipeline list (+ lifecycle labels)
 * POST /api/prospects        -> add one prospect (upserts the ATS Person)
 *   { action: "bulk", rows } -> CSV bulk upload with dedupe
 *   { action: "linkedin_search", campaignId, url, limit? } -> scrape a Sales Navigator
 *       / LinkedIn search URL into prospects (discovery only; no paid contact lookup)
 *   { action: "transition", prospectId, status } -> move lifecycle stage
 *   { action: "enrich", prospectId } -> resolve company email + phone (cheapest-first)
 */

import { getCore } from "../../../lib/core/repository";
import { addProspect, bulkUpload, transition, enrichProspect, LIFECYCLE, type NewProspectInput } from "../../../lib/prospects";
import { importFromLinkedInSearch } from "../../../lib/linkedin/searchImport";
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
  if (b?.action === "linkedin_search") {
    if (!b.campaignId || !b.url) return fail("missing_fields", 422, { detail: "campaignId and url required" });
    try {
      return ok(await importFromLinkedInSearch(ws, g.ctx.user.id, {
        url: b.url,
        campaignId: b.campaignId,
        limit: b.limit,
        motion: b.motion === "bd" ? "bd" : b.motion === "recruiting" ? "recruiting" : undefined,
      }));
    } catch (e: any) {
      return fail(e?.message ?? "import_failed", e?.status ?? 400);
    }
  }
  if (b?.action === "delete" && Array.isArray(b.ids)) {
    const core = getCore();
    let deleted = 0;
    for (const id of b.ids) {
      const p = await core.getProspect(id);
      if (p && p.workspaceId === ws) { await core.deleteProspect(id); deleted++; }
    }
    return ok({ deleted });
  }
  if (b?.action === "transition") {
    if (!b.prospectId || !b.status) return fail("missing_fields", 422);
    const p = await transition(b.prospectId, b.status);
    return p ? ok({ prospect: p }) : fail("not_found", 404);
  }
  if (b?.action === "enrich") {
    if (!b.prospectId) return fail("missing_fields", 422);
    try {
      return ok(await enrichProspect(ws, b.prospectId));
    } catch (e: any) {
      return fail(e.message ?? "enrich_failed", e.status ?? 400);
    }
  }
  if (!b?.fullName || !b?.campaignId) return fail("missing_fields", 422);
  const p = await addProspect({ ...b, workspaceId: ws });
  return ok({ prospect: p }, 201);
}
