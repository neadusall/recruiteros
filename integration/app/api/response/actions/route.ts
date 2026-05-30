/**
 * POST /api/response/actions
 * Manual inbox actions from the recruiter.
 *   { action: "classify", text }           -> test the classifier on raw text
 *   { action: "book", prospectId }         -> mark booked (booked_at + Loxo activity)
 *   { action: "suppress", prospectId }     -> add to do-not-contact across channels
 */

import { classify, markBooked, suppress } from "../../../../lib/response";
import { getCore } from "../../../../lib/core/repository";
import { nowIso } from "../../../../lib/core/ids";
import { requireSession, body, ok, fail } from "../../../../lib/api";

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<{ action?: string; text?: string; prospectId?: string }>(req);
  if (!b?.action) return fail("missing_action", 422);

  switch (b.action) {
    case "classify": {
      if (!b.text) return fail("missing_text", 422);
      return ok({ classification: await classify(b.text) });
    }
    case "book": {
      if (!b.prospectId) return fail("missing_prospectId", 422);
      await markBooked(b.prospectId);
      return ok({ ok: true });
    }
    case "suppress": {
      if (!b.prospectId) return fail("missing_prospectId", 422);
      const p = await getCore().getProspect(b.prospectId);
      await suppress(g.ctx.workspace.id, [p?.email, p?.linkedinUrl, p?.phone], "manual", nowIso());
      return ok({ ok: true });
    }
    default:
      return fail("unknown_action", 400);
  }
}
