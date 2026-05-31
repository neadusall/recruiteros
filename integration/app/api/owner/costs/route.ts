/**
 * /api/owner/costs  (OWNER ONLY)
 *   GET   -> the full cost-rate catalog (with overrides applied) + constants.
 *   PATCH -> override unit costs and/or pricing constants at runtime.
 *            { rateOverrides?: {rateId: usd}, constants?: {...} }
 *            Send a null rate value to clear an override.
 */

import { requireOwner, ok, fail, body } from "../../../../lib/api";
import { DEFAULT_RATES, DEFAULT_CONSTANTS, resolveRates } from "../../../../lib/billing/rates";
import { getCostConfig, updateCostConfig } from "../../../../lib/owner/config";

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const cfg = getCostConfig();
  const resolved = resolveRates(cfg.rateOverrides);
  return ok({
    rates: DEFAULT_RATES.map((r) => ({ ...resolved[r.id], default: r.unitCostUsd })),
    constants: { ...DEFAULT_CONSTANTS, ...cfg.constants },
    defaults: { constants: DEFAULT_CONSTANTS },
    overrides: cfg.rateOverrides,
  });
}

export async function PATCH(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const b = await body<{ rateOverrides?: Record<string, number | null>; constants?: Record<string, number> }>(req);
  if (!b) return fail("bad_request", 400);
  const cfg = updateCostConfig({
    rateOverrides: b.rateOverrides as Record<string, number> | undefined,
    constants: b.constants as any,
  });
  return ok({ updated: true, config: cfg });
}
