/**
 * POST /api/auth/2fa/login
 * Step two of sign-in for users with 2FA. Body: { challenge, code }.
 * Redeems the challenge from /api/auth/login with a TOTP or recovery code and
 * returns the authed context + session cookie.
 */

import { completeTwoFactorLogin } from "../../../../../lib/auth";
import { body, ok, fail, withSessionCookie } from "../../../../../lib/api";

export async function POST(req: Request) {
  const b = await body<{ challenge?: string; code?: string }>(req);
  if (!b?.challenge || !b?.code) return fail("missing_fields", 422);
  try {
    const auth = completeTwoFactorLogin(b.challenge, b.code);
    return withSessionCookie(ok({ ...auth, token: auth.session.token }), auth.session.token);
  } catch (e: any) {
    return fail(e.message ?? "login_failed", e.status ?? 401);
  }
}
