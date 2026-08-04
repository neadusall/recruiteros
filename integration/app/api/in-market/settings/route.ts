/**
 * In-Market · Video brand kit + settings.
 *
 * GET /api/in-market/settings              -> this workspace's video settings (brand kit + CTA).
 * PUT /api/in-market/settings  { ...patch } -> merge a sanitized patch; returns the result.
 *
 * Operator-only (requireSession). Powers the PiP Studio "Brand" tab; the studio bakes the public
 * fields into the watch links it shares so the recipient page renders branded.
 */

import { body, ok, requireCapability } from "../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = requireCapability(req, "sourcing:run");
  if ("response" in g) return g.response;
  const { getSettings } = await import("../../../../lib/inmarket/videoSettings");
  const { withBookingCalendar } = await import("../../../../lib/inmarket/booking");
  // With the built-in booking page on, calendarUrl is OUR /book link, so the
  // studio bakes it into every share exactly like a third-party calendar.
  return ok({ settings: await withBookingCalendar(g.ctx.workspace.id, await getSettings(g.ctx.workspace.id)) });
}

export async function PUT(req: Request) {
  const g = requireCapability(req, "sourcing:run");
  if ("response" in g) return g.response;
  const patch = (await body<any>(req)) || {};
  const { saveSettings } = await import("../../../../lib/inmarket/videoSettings");
  const { withBookingCalendar } = await import("../../../../lib/inmarket/booking");
  return ok({ settings: await withBookingCalendar(g.ctx.workspace.id, await saveSettings(g.ctx.workspace.id, patch)) });
}
