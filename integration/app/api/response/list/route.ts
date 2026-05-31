/**
 * GET /api/response/list  -> the unified inbox (recent processed responses).
 * Also returns the routing-rules matrix so the UI can render the rules table.
 */

import { recentResponses, ROUTING_RULES, CLASS_ORDER } from "../../../../lib/response";
import { requireSession, ok } from "../../../../lib/api";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const items = await recentResponses(g.ctx.workspace.id, 100);
  return ok({ items, rules: ROUTING_RULES, order: CLASS_ORDER });
}
