/**
 * POST /api/linkedin/agent/report
 *   The extension reports the outcome of a one-off action it executed.
 *   Auth: Bearer <ext-token>.
 *
 *   Body: { actionId, ok, info?, providerMessageId? }
 */

import { reportResult } from "../../../../../lib/linkedin/inbridge";
import { workspaceForToken, bearerToken } from "../../../../../lib/exttoken";
import { body, ok, fail } from "../../../../../lib/api";

export async function POST(req: Request) {
  const ws = await workspaceForToken(bearerToken(req));
  if (!ws) return fail("unauthorized", 401);
  const b = await body<{ actionId?: string; ok?: boolean; info?: string; providerMessageId?: string }>(req);
  if (!b?.actionId) return fail("missing_actionId", 422);
  const done = await reportResult(ws, b.actionId, !!b.ok, b.info, b.providerMessageId);
  return done ? ok({ ok: true }) : fail("unknown_action", 404);
}
