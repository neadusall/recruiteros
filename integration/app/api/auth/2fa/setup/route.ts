/**
 * POST /api/auth/2fa/setup
 * Begin enrollment for the signed-in user: returns a fresh (not-yet-active)
 * secret + otpauth URI to load into an authenticator app. Confirm with
 * /api/auth/2fa/enable before it takes effect.
 */

import { requireSession, ok, fail } from "../../../../../lib/api";
import { beginTwoFactorSetup } from "../../../../../lib/auth";

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  try {
    return ok(beginTwoFactorSetup(g.ctx.user.id));
  } catch (e: any) {
    return fail(e.message ?? "setup_failed", e.status ?? 400);
  }
}
