/**
 * GET  /api/data                 -> warehouse list/search (+ stats + provider status)
 *      ?q= &company= &hasEmail=1 &hasPhone=1 &source= &limit= &offset=
 * POST /api/data
 *   { action: "import", rows, mapping? }      -> ingest exported rows (dedupe upsert)
 *   { action: "pull", provider, query }       -> programmatic pull via official API (when keyed)
 *   { action: "enrich", id, field? }          -> resolve email/phone for one record
 *   { action: "promote", ids, campaignId }    -> send records to Candidates as prospects
 *   { action: "delete", ids }                 -> drop records
 */

import { requireSession, body, ok, fail } from "../../../lib/api";
import {
  listRecords, getRecord, upsertRecords, deleteRecords, enrichRecord, stats,
  rowsToInputs, providerStatus, getProvider, ProviderNotConfigured,
  type DataSource,
} from "../../../lib/data";
import { addProspect } from "../../../lib/prospects";
import { ensureLumeSeed } from "../../../lib/data/autoseed";
import { loxoIsActive, pushPersonToLoxo } from "../../../lib/ats";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  await ensureLumeSeed(ws); // first-open auto-load of the bundled export (once, when empty)
  const u = new URL(req.url);
  const { records, total } = await listRecords(ws, {
    q: u.searchParams.get("q") ?? undefined,
    company: u.searchParams.get("company") ?? undefined,
    hasEmail: u.searchParams.get("hasEmail") === "1",
    hasPhone: u.searchParams.get("hasPhone") === "1",
    source: (u.searchParams.get("source") as DataSource | null) ?? undefined,
    limit: u.searchParams.get("limit") ? parseInt(u.searchParams.get("limit") as string, 10) : undefined,
    offset: u.searchParams.get("offset") ? parseInt(u.searchParams.get("offset") as string, 10) : undefined,
  });
  return ok({ records, total, stats: await stats(ws), providers: providerStatus() });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);

  if (b?.action === "import" && Array.isArray(b.rows)) {
    const inputs = rowsToInputs(b.rows, { mapping: b.mapping, source: "csv" });
    if (!inputs.length) return fail("nothing_to_import", 422, { detail: "No rows with a resolvable name." });
    const res = await upsertRecords(ws, inputs);
    return ok({ added: res.added, updated: res.updated, total: res.added + res.updated });
  }

  if (b?.action === "pull") {
    const provider = getProvider(b.provider || "zoominfo");
    if (!provider) return fail("unknown_provider", 404);
    try {
      const inputs = await provider.search(b.query || {});
      const res = await upsertRecords(ws, inputs);
      return ok({ added: res.added, updated: res.updated, total: res.added + res.updated });
    } catch (e: any) {
      if (e instanceof ProviderNotConfigured) return fail(e.message, 503, { provider: e.providerId });
      return fail(e?.message ?? "pull_failed", e?.status ?? 400);
    }
  }

  if (b?.action === "enrich") {
    if (!b.id) return fail("missing_fields", 422);
    const rec = await getRecord(ws, b.id);
    if (!rec) return fail("not_found", 404);
    const field = b.field === "email" ? "email" : b.field === "phone" ? "phone" : undefined;
    const { record, found } = await enrichRecord(rec, field);
    // Write-back: when we resolve new contact info, mirror it to Loxo so the ATS
    // stays current. Best-effort; never fails the enrich. Push only on this
    // user action — keeps the sync/webhook pull path loop-free.
    let push: unknown = undefined;
    if (found && b.push !== false && (await loxoIsActive(ws))) {
      push = await pushPersonToLoxo(ws, b.id).catch((e) => ({ ok: false, error: e?.message }));
    }
    return ok({ record, found, push });
  }

  if (b?.action === "promote" && Array.isArray(b.ids)) {
    if (!b.campaignId) return fail("missing_fields", 422, { detail: "campaignId required" });
    let added = 0;
    for (const id of b.ids) {
      const rec = await getRecord(ws, id);
      if (!rec) continue;
      await addProspect({
        workspaceId: ws,
        campaignId: b.campaignId,
        fullName: rec.fullName,
        email: rec.email,
        phone: rec.phone || rec.directPhone,
        company: rec.company,
        companyDomain: rec.companyDomain,
        title: rec.title,
        linkedinUrl: rec.linkedinUrl,
        location: [rec.city, rec.state, rec.country].filter(Boolean).join(", ") || undefined,
        motion: b.motion === "bd" ? "bd" : b.motion === "recruiting" ? "recruiting" : undefined,
        category: "Data warehouse",
      });
      added++;
    }
    return ok({ added, campaignId: b.campaignId });
  }

  if (b?.action === "delete" && Array.isArray(b.ids)) {
    return ok({ deleted: await deleteRecords(ws, b.ids) });
  }

  return fail("unknown_action", 400);
}
