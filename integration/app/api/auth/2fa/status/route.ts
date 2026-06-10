/**
 * GET /api/auth/2fa/status
 * The signed-in user's second-factor state (enabled / pending / recovery left).
 */

import { requireSession, ok } from "../../../../../lib/api";
import { twoFactorStatus } from "../../../../../lib/auth";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  return ok(twoFactorStatus(g.ctx.user.id));
}
