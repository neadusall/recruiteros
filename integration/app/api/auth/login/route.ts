/**
 * POST /api/auth/login
 * Body: { email, password }. Returns the authed context + session cookie.
 */

import { login } from "../../../../lib/auth";
import { body, ok, fail, withSessionCookie } from "../../../../lib/api";

export async function POST(req: Request) {
  const b = await body<{ email?: string; password?: string }>(req);
  if (!b?.email || !b?.password) return fail("missing_fields", 422);
  try {
    const r = await login(b.email, b.password);
    // 2FA users: password is verified, but no session is issued until they
    // submit a valid code to /api/auth/2fa/login with this challenge.
    if (r.status === "twoFactor") return ok({ twoFactorRequired: true, challenge: r.challenge });
    const auth = r.auth;
    return withSessionCookie(ok({ ...auth, token: auth.session.token }), auth.session.token);
  } catch (e: any) {
    return fail(e.message ?? "login_failed", e.status ?? 401);
  }
}
