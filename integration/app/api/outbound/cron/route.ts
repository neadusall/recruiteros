/**
 * RecruitersOS · API · /api/outbound/cron
 *
 * Redundant external trigger for the outbound tick (rollups + trigger engine
 * + scheduled notifications). The in-process scheduler is the primary clock;
 * this endpoint mirrors the other cron routes as a manual/external fallback.
 */

import { ok, fail } from "../../../../lib/api";
import { runOutboundTick } from "../../../../lib/outbound/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const secret = (process.env.RECRUITEROS_CRON_SECRET || process.env.RECRUITEROS_API_TOKEN || "").trim();
  if (!secret) return true; // same posture as the other cron endpoints
  const h = req.headers.get("authorization") || "";
  return h === `Bearer ${secret}`;
}

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) return fail("unauthorized", 401);
  try {
    await runOutboundTick();
    return ok({ done: true });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "tick_failed", 500);
  }
}
