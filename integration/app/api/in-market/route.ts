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
  return ok({ promoted });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);

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
      limit: b?.limit,
    },
    new Date().toISOString(),
    ws,
  );
  return ok(result);
}
