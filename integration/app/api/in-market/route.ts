/**
 * In-Market Leads (Business Development).
 *
 * GET  /api/in-market                 -> recently promoted in-market prospects (quick recap)
 * POST /api/in-market
 *   { query, industries?, geos?, companyName?, titles?, headcountBands?, limit? }
 *       -> search the market for companies actively hiring (free sources, ranked)
 *   { action: "promote", campaignId, lead, manager? }
 *       -> create a Prospect (the hiring manager, paired to the company) on the campaign
 *
 * BD motion only; the engine searches company-side hiring-intent signals.
 */

import { searchInMarket, promoteLead, type InMarketLead, type HiringManagerLead } from "../../../lib/inmarket";
import { getCore } from "../../../lib/core/repository";
import { requireSession, body, ok, fail } from "../../../lib/api";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const all = await getCore().listProspects(g.ctx.workspace.id);
  const promoted = all.filter((p) => p.category === "in_market").slice(0, 50);
  // Daily import read for the Hire Signals banner; also kick the accumulator so the
  // pool fills even before the first search. Best-effort.
  let stats: unknown;
  try {
    const { ensureAccumulator } = await import("../../../lib/inmarket/accumulator");
    const { poolStats } = await import("../../../lib/inmarket/pool");
    ensureAccumulator();
    stats = await poolStats();
  } catch { /* ignore */ }
  return ok({ promoted, stats });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);

  // Cost estimate for pushing N selected people (shown in the approve/cancel gate).
  if (b?.action === "estimate") {
    const { estimatePushCost } = await import("../../../lib/inmarket/launch");
    const count = Number(b.count) || (Array.isArray(b.leads) ? b.leads.length : 0);
    return ok({ estimate: estimatePushCost(count, { directDial: b.directDial === true }) });
  }

  // Dive into ONE company's own public ATS board → every open role they're hiring for
  // (no aggregator API), with a hiring manager mapped to each. On-demand (deep-dive button).
  if (b?.action === "company_roles") {
    const company = String(b.company ?? "").trim();
    if (!company) return fail("missing_company", 422);
    try {
      const { resolveCompanyRoles } = await import("../../../lib/inmarket/companyRoles");
      const { hiringManagersFor } = await import("../../../lib/inmarket");
      const r = await resolveCompanyRoles(company, b.domain ? String(b.domain) : undefined);
      const roleTitles = r.roles.map((x) => x.title);
      const hiringManagers = hiringManagersFor(roleTitles);
      return ok({ roles: roleTitles, detail: r.roles, hiringManagers, source: r.source, total: roleTitles.length });
    } catch (e: any) {
      return fail(e?.message ?? "company_roles_failed", e?.status ?? 400);
    }
  }

  // Kick the omnichannel orchestrator (n8n) right after an approved batch is promoted.
  if (b?.action === "launch_outreach") {
    const { kickOutreach } = await import("../../../lib/inmarket/launch");
    const result = await kickOutreach({ workspaceId: ws, campaignId: b.campaignId, count: Number(b.count) || 0 });
    return ok({ launch: result });
  }

  if (b?.action === "promote") {
    if (!b.campaignId || !b.lead) return fail("missing_fields", 422, { detail: "campaignId and lead required" });
    try {
      const prospect = await promoteLead(
        ws,
        b.campaignId,
        b.lead as InMarketLead,
        b.manager as HiringManagerLead | undefined,
        { findDirectDial: b.findDirectDial === true },
      );
      return ok({ prospect }, 201);
    } catch (e: any) {
      return fail(e.message ?? "promote_failed", e.status ?? 400);
    }
  }

  // AI decision-maker inference for one company (on demand, uses ANTHROPIC_API_KEY).
  if (b?.action === "refine_managers") {
    const lead = (b.lead ?? {}) as Partial<InMarketLead>;
    try {
      const { aiHiringManagers } = await import("../../../lib/inmarket/aiManagers");
      const hiringManagers = await aiHiringManagers({
        company: lead.company ?? "",
        industry: lead.industry,
        headcountBand: lead.headcountBand,
        roles: lead.roles ?? [],
      });
      if (!hiringManagers) return fail("ai_unavailable", 409, { detail: "set ANTHROPIC_API_KEY (or no roles)" });
      return ok({ hiringManagers });
    } catch (e: any) {
      return fail(e?.message ?? "refine_failed", e?.status ?? 400);
    }
  }

  // ---- Curation: the daily decision-maker list (the database of prospects to market to) ----

  // The real numbers: funnel counts by stage, sliced by hiring signal + function. Bundles the
  // engine heartbeat so the UI can show "pool fed / curated N ago" and flag a stalled engine.
  if (b?.action === "curation_funnel") {
    const { curationFunnel } = await import("../../../lib/inmarket/curation");
    const { engineHealth } = await import("../../../lib/inmarket/accumulator");
    const [funnel, health] = await Promise.all([curationFunnel(), engineHealth()]);
    return ok({ funnel, health });
  }

  // Standalone liveness probe for the lead engine (last cycle / last curation tick + errors).
  if (b?.action === "engine_health") {
    const { engineHealth } = await import("../../../lib/inmarket/accumulator");
    return ok({ health: await engineHealth() });
  }

  // The list itself, for review (filterable; contactableOnly = has a real person + email).
  if (b?.action === "curation_list") {
    const { listCurated } = await import("../../../lib/inmarket/curation");
    const list = await listCurated({
      status: b.status, signalType: b.signalType, function: b.function,
      contactableOnly: b.contactableOnly === true, limit: b.limit,
    });
    return ok({ curated: list });
  }

  // Review gate, step 1: approve a batch (contactable → queued).
  if (b?.action === "curation_approve") {
    const { approveForBulk } = await import("../../../lib/inmarket/curation");
    const n = await approveForBulk(Array.isArray(b.ids) ? b.ids : []);
    return ok({ approved: n });
  }

  // Review gate, step 2: enroll the approved batch into the BD Bulk MPC sender.
  if (b?.action === "curation_enroll") {
    if (!b.campaignId) return fail("missing_campaign", 422, { detail: "campaignId required" });
    const { enrollToBulk } = await import("../../../lib/inmarket/curation");
    const res = await enrollToBulk(ws, String(b.campaignId), Array.isArray(b.ids) ? b.ids : [], new Date().toISOString());
    return ok(res);
  }

  // Continuous email validation — the external validator pulls the pending list, then streams
  // verdicts back. Invalid addresses are suppressed (never enrolled); valid ones are confirmed.
  if (b?.action === "validation_pending") {
    const { pendingValidationEmails } = await import("../../../lib/inmarket/curation");
    return ok({ emails: await pendingValidationEmails(Math.min(Number(b.limit) || 1000, 5000)) });
  }
  if (b?.action === "validation_results") {
    const { applyEmailValidation } = await import("../../../lib/inmarket/curation");
    const results = Array.isArray(b.results) ? b.results : [];
    const n = await applyEmailValidation(results, new Date().toISOString());
    return ok({ updated: n });
  }

  // On-demand curation run (the accumulator also does this hourly): research the top companies'
  // decision-makers now and refresh the list.
  if (b?.action === "curate_now") {
    const { queryPool } = await import("../../../lib/inmarket/pool");
    const { curateFromPool } = await import("../../../lib/inmarket/curation");
    const n = Math.min(Number(b.limit) || 60, 300);
    const top = await queryPool({ limit: n } as any, n);
    const report = await curateFromPool(
      top.map((l: any) => ({ company: l.company, domain: l.domain, industry: l.industry, signalType: l.signalType, reason: l.reason, score: l.score, employeeCount: l.employeeCount, roleDetails: l.roleDetails, roles: l.roles, sourceUrl: l.sourceUrl })),
      { limit: n, concurrency: 4, minScore: Number(b.minScore) || 0, nowIso: new Date().toISOString() },
    );
    return ok({ report });
  }

  // Default: a market search.
  const result = await searchInMarket(
    {
      query: b?.query,
      industries: b?.industries,
      geos: b?.geos,
      companyName: b?.companyName,
      roleQuery: b?.roleQuery,
      titles: b?.titles,
      signalTypes: b?.signalTypes,
      headcountBands: b?.headcountBands,
      postedWithinDays: b?.postedWithinDays,
      addedWithinDays: b?.addedWithinDays,
      confirmedSizeOnly: b?.confirmedSizeOnly,
      limit: b?.limit,
    },
    new Date().toISOString(),
    ws,
  );
  return ok(result);
}
