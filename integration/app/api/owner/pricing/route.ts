/**
 * GET /api/owner/pricing  (OWNER ONLY)
 * The pricing brain. With no params it returns the full preset table
 * (5k / 10k / 20k for both Recruiting OS and BD OS) at the configured margin.
 * With params it acts as a live calculator:
 *   ?emails=12000&steps=3&phone=1&ai=1&margin=0.85&motion=bd
 */

import { requireOwner, ok } from "../../../../lib/api";
import { estimateCost, recommendPrice, presetPricingTable } from "../../../../lib/billing/pricing";
import { getCostConfig } from "../../../../lib/owner/config";
import type { Motion } from "../../../../lib/core/types";

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;

  const url = new URL(req.url);
  const cfg = getCostConfig();
  const margin = numParam(url, "margin");
  const sharedOpts = {
    rateOverrides: cfg.rateOverrides,
    constants: cfg.constants,
    // Mobile + landline are separate opt-ins; ?phone=1 enables both (back-compat).
    wantMobile: boolParam(url, "mobile") || boolParam(url, "phone"),
    wantLandline: boolParam(url, "landline") || boolParam(url, "phone"),
    aiPersonalize: url.searchParams.has("ai") ? boolParam(url, "ai") : true,
    sequenceStepsPerProspect: numParam(url, "steps") || undefined,
    targetGrossMargin: margin || undefined,
  };

  const presets = presetPricingTable(sharedOpts);

  let calculator = null;
  const emails = numParam(url, "emails");
  if (emails && emails > 0) {
    const motion = (url.searchParams.get("motion") as Motion) || "recruiting";
    const breakdown = estimateCost({ emailsPerMonth: emails, ...sharedOpts });
    calculator = recommendPrice(breakdown, motion, {
      targetGrossMargin: sharedOpts.targetGrossMargin,
      constants: cfg.constants,
    });
  }

  return ok({ presets, calculator, constants: cfg.constants });
}

function numParam(url: URL, k: string): number {
  const v = url.searchParams.get(k);
  return v == null ? 0 : Number(v) || 0;
}
function boolParam(url: URL, k: string): boolean {
  const v = url.searchParams.get(k);
  return v === "1" || v === "true";
}
