/**
 * GET  /api/outreach?motion=recruiting|bd
 *   -> the Outreach readiness snapshot (ATS, SMS, enrichment + credits,
 *      Job Search, sending domains down to the inbox, LinkedIn warm state,
 *      and the per-motion activation gate). Session-gated so recruiters can
 *      see readiness too.
 *
 * POST /api/outreach { action }
 *   toggle-enrichment { on }   -> turn the enrichment waterfall on/off
 *   toggle-jobsearch  { on }   -> turn Job Search on/off
 *   topup-credits     { amount } -> grant more enrichment credits
 *   Mutations require integrations:manage; the response echoes the fresh
 *   snapshot so the UI repaints from one source of truth.
 */

import { outreachSnapshot, setFeature, topUpCredits } from "../../../lib/outreach";
import { requireSession, requireCapability, body, ok, fail } from "../../../lib/api";
import type { Motion } from "../../../lib/core/types";

function motionOf(req: Request): Motion {
  const m = new URL(req.url).searchParams.get("motion");
  return m === "bd" ? "bd" : "recruiting";
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  return ok(outreachSnapshot(g.ctx.workspace.id, motionOf(req)));
}

export async function POST(req: Request) {
  const g = requireCapability(req, "integrations:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{ action?: string; on?: boolean; amount?: number; motion?: Motion }>(req);
  const motion: Motion = b?.motion === "bd" ? "bd" : motionOf(req);

  switch (b?.action) {
    case "toggle-enrichment":
      setFeature(ws, "enrichment", b.on !== false);
      break;
    case "toggle-jobsearch":
      setFeature(ws, "jobSearch", b.on !== false);
      break;
    case "topup-credits":
      topUpCredits(ws, typeof b.amount === "number" ? b.amount : 1000);
      break;
    default:
      return fail("unknown_action", 400);
  }
  return ok(outreachSnapshot(ws, motion));
}
