/**
 * GET  /api/companies                 -> the BD company book (+ stats)
 *      ?q= &status= &source= &limit= &offset=
 * POST /api/companies
 *   { action: "upsert", companies }    -> add/update rows (manual or import)
 *   { action: "patch", id, status?, tags?, owner?, type? } -> edit one row
 *   { action: "delete", ids }          -> remove rows
 *   { action: "sync" }                 -> pull Companies from Loxo now (admin only)
 *
 * This is the durable home for the Companies tab, which previously lived only in
 * the browser's localStorage. A Loxo sync (cron/webhook) writes here too.
 */

import {
  listCompanies,
  upsertCompanies,
  patchCompany,
  deleteCompanies,
  companyStats,
  type CompanyStatus,
  type CompanySource,
} from "../../../lib/companies";
import { syncLoxo, getActiveVendor } from "../../../lib/ats";
import { requireSession, body, ok, fail, context } from "../../../lib/api";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const u = new URL(req.url);
  const { companies, total } = await listCompanies(ws, {
    q: u.searchParams.get("q") ?? undefined,
    status: (u.searchParams.get("status") as CompanyStatus | null) ?? undefined,
    source: (u.searchParams.get("source") as CompanySource | null) ?? undefined,
    limit: u.searchParams.get("limit") ? parseInt(u.searchParams.get("limit") as string, 10) : undefined,
    offset: u.searchParams.get("offset") ? parseInt(u.searchParams.get("offset") as string, 10) : undefined,
  });
  return ok({ companies, total, stats: await companyStats(ws) });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);

  if (b?.action === "upsert" && Array.isArray(b.companies)) {
    const res = await upsertCompanies(ws, b.companies);
    return ok({ added: res.added, updated: res.updated, total: res.added + res.updated });
  }

  if (b?.action === "patch" && b.id) {
    const rec = await patchCompany(ws, b.id, {
      status: b.status,
      tags: b.tags,
      owner: b.owner,
      type: b.type,
    });
    return rec ? ok({ company: rec }) : fail("not_found", 404);
  }

  if (b?.action === "delete" && Array.isArray(b.ids)) {
    const removed = await deleteCompanies(ws, b.ids);
    return ok({ removed });
  }

  if (b?.action === "sync") {
    // Pulling from the ATS is an admin action (touches the ATS connection).
    const ctx = context(req);
    if (!ctx?.capabilities.includes("ats:manage")) return fail("forbidden", 403, { needs: "ats:manage" });
    const vendor = await getActiveVendor(ws);
    if (vendor !== "loxo") return fail("ats_not_connected", 409);
    const report = await syncLoxo(ws);
    if (!report.ok) return fail(report.error || "sync_failed", 502, { report });
    return ok({ report });
  }

  return fail("unknown_action", 400);
}
