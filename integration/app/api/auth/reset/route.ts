/**
 * POST /api/auth/reset          Body: { email }            -> email a reset link
 * GET  /api/auth/reset?token=   -> { valid, email? } so the page can pre-validate
 * PUT  /api/auth/reset          Body: { token, password }  -> set new password + session
 *
 * The "Forgot password?" flow. POST never reveals whether an email exists.
 */

import { requestPasswordReset, peekResetToken, resetPassword } from "../../../../lib/auth";
import { body, ok, fail, withSessionCookie } from "../../../../lib/api";

export async function POST(req: Request) {
  const b = await body<{ email?: string }>(req);
  if (!b?.email) return fail("missing_email", 422);
  await requestPasswordReset(b.email);
  return ok({ sent: true });
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!token) return fail("missing_token", 422);
  return ok(peekResetToken(token));
}

export async function PUT(req: Request) {
  const b = await body<{ token?: string; password?: string }>(req);
  if (!b?.token || !b?.password) return fail("missing_fields", 422);
  try {
    const auth = await resetPassword(b.token, b.password);
    return withSessionCookie(ok({ ...auth, token: auth.session.token }), auth.session.token);
  } catch (e: any) {
    return fail(e.message ?? "reset_failed", e.status ?? 401);
  }
}
