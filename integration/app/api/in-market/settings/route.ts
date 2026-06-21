/**
 * In-Market · Video brand kit + settings.
 *
 * GET /api/in-market/settings              -> this workspace's video settings (brand kit + CTA).
 * PUT /api/in-market/settings  { ...patch } -> merge a sanitized patch; returns the result.
 *
 * Operator-only (requireSession). Powers the PiP Studio "Brand" tab; the studio bakes the public
 * fields into the watch links it shares so the recipient page renders branded.
 */

import { requireSession, body, ok } from "../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const { getSettings } = await import("../../../../lib/inmarket/videoSettings");
  return ok({ settings: await getSettings(g.ctx.workspace.id) });
}

export async function PUT(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const patch = (await body<any>(req)) || {};
  const { saveSettings } = await import("../../../../lib/inmarket/videoSettings");
  return ok({ settings: await saveSettings(g.ctx.workspace.id, patch) });
}
