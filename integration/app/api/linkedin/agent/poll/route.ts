/**
 * POST /api/linkedin/agent/poll
 *   The Chrome extension polls for the next queued action (search / connect /
 *   message / …) for its workspace's LinkedIn accounts, and executes it in the
 *   user's own browser session. Auth: Bearer <ext-token>.
 *
 *   -> { action: BridgeAction | null }
 */

import { claimNext } from "../../../../../lib/linkedin/inbridge";
import { workspaceForToken, bearerToken } from "../../../../../lib/exttoken";
import { ok, fail } from "../../../../../lib/api";

export async function POST(req: Request) {
  const ws = await workspaceForToken(bearerToken(req));
  if (!ws) return fail("unauthorized", 401);
  return ok({ action: await claimNext(ws) });
}
