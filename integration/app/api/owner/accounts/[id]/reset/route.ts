/**
 * POST /api/owner/accounts/[id]/reset  (OWNER ONLY)
 * The hard reset. Body controls scope:
 *   { purgeData?, revokeSessions?, resetPasswords?, suspend?, deleteAccount? }
 * Default (empty body) = revoke all sessions only. resetPasswords returns the
 * one-time temp passwords in the response (shown once in the console).
 */

import { requireOwner, ok, fail, body } from "../../../../../../lib/api";
import { hardReset, type HardResetOptions } from "../../../../../../lib/owner";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const opts = (await body<HardResetOptions>(req)) ?? {};
  const result = hardReset(params.id, opts);
  if (!result) return fail("not_found", 404);
  return ok(result);
}
