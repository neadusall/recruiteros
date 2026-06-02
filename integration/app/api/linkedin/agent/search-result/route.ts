/**
 * POST /api/linkedin/agent/search-result
 *   The extension streams scraped profiles for a `search` action it claimed.
 *   Each call carries the FULL set collected so far; `done: true` resolves the
 *   backend's long-poll so the profiles flow back into the import. Auth: Bearer
 *   <ext-token>.
 *
 *   Body: { actionId, items: SearchProfile[], done?: boolean }
 */

import { resolveSearch } from "../../../../../lib/linkedin/inbridge";
import { workspaceForToken, bearerToken } from "../../../../../lib/exttoken";
import { body, ok, fail } from "../../../../../lib/api";
import type { SearchProfile } from "../../../../../lib/linkedin/provider";

export async function POST(req: Request) {
  const ws = await workspaceForToken(bearerToken(req));
  if (!ws) return fail("unauthorized", 401);
  const b = await body<{ actionId?: string; items?: SearchProfile[]; done?: boolean }>(req);
  if (!b?.actionId) return fail("missing_actionId", 422);
  const items = Array.isArray(b.items) ? b.items : [];
  const found = await resolveSearch(ws, b.actionId, items, !!b.done);
  return found ? ok({ ok: true, count: items.length }) : fail("unknown_search_action", 404);
}
