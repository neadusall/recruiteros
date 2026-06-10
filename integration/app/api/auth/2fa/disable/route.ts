/**
 * POST /api/auth/2fa/disable
 * Turn off 2FA for the signed-in user. Body: { code }.
 * Requires a current TOTP or recovery code to prove possession of the factor.
 */

import { requireSession, ok, fail, body } from "../../../../../lib/api";
import { disableTwoFactor } from "../../../../../lib/auth";

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<{ code?: string }>(req);
  if (!b?.code) return fail("missing_fields", 422);
  try {
    disableTwoFactor(g.ctx.user.id, b.code);
    return ok({ disabled: true });
  } catch (e: any) {
    return fail(e.message ?? "disable_failed", e.status ?? 400);
  }
}
