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
    const auth = await login(b.email, b.password);
    return withSessionCookie(ok({ ...auth, token: auth.session.token }), auth.session.token);
  } catch (e: any) {
    return fail(e.message ?? "login_failed", e.status ?? 401);
  }
}
