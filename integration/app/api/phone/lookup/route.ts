/**
 * GET /api/phone/lookup
 *   ?number=+13105551234  -> contacts matching a phone number (caller ID /
 *                            dialed-number recognition; may be several)
 *   ?q=jane               -> typeahead over prospects (associate-call flows)
 */

import { requireCapability, ok, fail } from "../../../../lib/api";
import { matchByPhone, searchContacts } from "../../../../lib/phone/contacts";

export async function GET(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  const number = url.searchParams.get("number");
  const q = url.searchParams.get("q");
  if (number) return ok({ matches: await matchByPhone(g.ctx.workspace.id, number) });
  if (q) return ok({ matches: await searchContacts(g.ctx.workspace.id, q) });
  return fail("missing_query", 400);
}
