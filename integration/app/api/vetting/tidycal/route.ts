/**
 * AI Vetting · TidyCal sync API
 *   GET  /api/vetting/tidycal   -> preview: upcoming bookings mapped to desks (no writes)
 *   POST /api/vetting/tidycal   -> { action: "sync" } pull bookings, create/update the
 *                                  matching candidate per booking, pre-enrich LinkedIn
 *
 * Session-gated. The booking's type title routes it to a desk (matched on the
 * desk's role title); the booker's phone is the key the inbound caller-ID is
 * matched on; their LinkedIn URL is researched ahead of the call. Safe in
 * dry-run when TIDYCAL_API_TOKEN is unset (returns configured:false).
 *
 * Wire the POST to a periodic cron so newly-booked candidates are researched and
 * staged automatically before their call.
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";
import { syncTidyCalBookings } from "../../../../lib/vetting";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const res = await syncTidyCalBookings(g.ctx.workspace.id, false); // preview only
  return ok(res);
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<{ action?: string }>(req);
  if (b?.action && b.action !== "sync") return fail("unknown_action", 422);
  const res = await syncTidyCalBookings(g.ctx.workspace.id, true);
  return ok(res);
}
