/**
 * POST /api/auth/2fa/enable
 * Confirm enrollment for the signed-in user. Body: { code }.
 * On a valid code, 2FA goes active and one-time recovery codes are returned
 * ONCE (store them somewhere safe — only their hashes are kept).
 */

import { requireSession, ok, fail, body } from "../../../../../lib/api";
import { confirmTwoFactorSetup } from "../../../../../lib/auth";

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<{ code?: string }>(req);
  if (!b?.code) return fail("missing_fields", 422);
  try {
    return ok(confirmTwoFactorSetup(g.ctx.user.id, b.code));
  } catch (e: any) {
    return fail(e.message ?? "enable_failed", e.status ?? 400);
  }
}
