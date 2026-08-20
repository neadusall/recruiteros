/**
 * GET /api/phone-intel/phone-stats?motion=
 * Live phone-reachability rollup for a motion's pipeline: how many prospects have
 * a number, how many are confirmed ACTUAL business lines (droppable), how many are
 * mobile / personal / residential (never dialed), and how many are ready to drop
 * now. Read from the cached per-prospect classification (no lookups here).
 * Session-gated (voice:dial).
 */

import { ok, requireCapability } from "../../../../lib/api";
import type { Motion } from "../../../../lib/core/types";
import { phoneReachabilityStats } from "../../../../lib/phoneintel";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const m = new URL(req.url).searchParams.get("motion");
  const motion: Motion | undefined = m === "bd" ? "bd" : m === "recruiting" ? "recruiting" : undefined;
  const stats = await phoneReachabilityStats(g.ctx.workspace.id, motion);
  return ok({ stats });
}
