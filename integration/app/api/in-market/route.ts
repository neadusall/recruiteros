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
    return ok({ estimate: estimatePushCost(count, { includeVoice: b.includeVoice !== false }) });
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

  // Default: a market search.
  const result = await searchInMarket(
    {
      query: b?.query,
      industries: b?.industries,
      geos: b?.geos,
      companyName: b?.companyName,
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
