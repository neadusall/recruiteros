/**
 * POST /api/auth/register
 * Enterprise sign-up. Body: { email, password, name }.
 * Provisions (or joins) a workspace from the email domain, issues a session
 * cookie, and sends a verification email.
 */

import { register } from "../../../../lib/auth";
import { body, ok, fail, withSessionCookie } from "../../../../lib/api";

export async function POST(req: Request) {
  const b = await body<{ email?: string; password?: string; name?: string }>(req);
  if (!b?.email || !b?.password) return fail("missing_fields", 422, { detail: "email and password required" });
  try {
    const auth = await register(b.email, b.password, b.name ?? "");
    return withSessionCookie(ok({ ...auth, token: auth.session.token }, 201), auth.session.token);
  } catch (e: any) {
    return fail(e.message ?? "register_failed", e.status ?? 400);
  }
}
