/**
 * POST /api/auth/magic-link   Body: { email }                -> emails a link
 * PUT  /api/auth/magic-link   Body: { token }                -> exchanges for a session
 *
 * Passwordless enterprise sign-in: "just sign up with your email".
 */

import { requestMagicLink, consumeMagicLink } from "../../../../lib/auth";
import { body, ok, fail, withSessionCookie } from "../../../../lib/api";

export async function POST(req: Request) {
  const b = await body<{ email?: string }>(req);
  if (!b?.email) return fail("missing_email", 422);
  await requestMagicLink(b.email);
  return ok({ sent: true });
}

export async function PUT(req: Request) {
  const b = await body<{ token?: string }>(req);
  if (!b?.token) return fail("missing_token", 422);
  try {
    const auth = await consumeMagicLink(b.token);
    return withSessionCookie(ok({ ...auth, token: auth.session.token }), auth.session.token);
  } catch (e: any) {
    return fail(e.message ?? "invalid_token", e.status ?? 401);
  }
}
