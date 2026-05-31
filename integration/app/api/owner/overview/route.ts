/**
 * GET /api/owner/overview  (OWNER ONLY)
 * The single-screen pulse of the whole business: MRR, cost, gross profit,
 * margin, account counts, and a by-motion / by-category cost split.
 */

import { requireOwner, ok } from "../../../../lib/api";
import { listFullAccounts } from "../../../../lib/owner";
import { totalMrr } from "../../../../lib/owner/store";
import { spendRollup, type SpendWindow } from "../../../../lib/billing/ledger";

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;

  const url = new URL(req.url);
  const window = (url.searchParams.get("window") as SpendWindow) || "30d";

  const accounts = listFullAccounts(window);
  const roll = spendRollup(window);
  const mrr = totalMrr();
  const cost = roll.totalCostUsd;
  const grossProfit = round(mrr - cost);

  return ok({
    window,
    mrrUsd: mrr,
    costUsd: cost,
    grossProfitUsd: grossProfit,
    grossMarginPct: mrr > 0 ? round((grossProfit / mrr) * 100, 1) : 0,
    accounts: {
      total: accounts.length,
      active: accounts.filter((a) => !a.suspended).length,
      suspended: accounts.filter((a) => a.suspended).length,
      paying: accounts.filter((a) => a.monthlyPriceUsd > 0).length,
    },
    costByCategory: roll.byCategory,
    costByMotion: roll.byMotion,
    costBySource: roll.bySource,
    owner: g.ctx.user.email,
  });
}

function round(n: number, dp = 2): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}
