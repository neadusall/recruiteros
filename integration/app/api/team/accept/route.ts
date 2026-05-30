/**
 * PUT /api/team/accept  Body: { token, name?, password? }
 * Accept a team invite: join the inviting workspace at the invited role and get
 * a session. Used by the invite link on signup.html (?invite=<token>).
 */

import { acceptInvite } from "../../../../lib/auth/team";
import { body, ok, fail, withSessionCookie } from "../../../../lib/api";

export async function PUT(req: Request) {
  const b = await body<{ token?: string; name?: string; password?: string }>(req);
  if (!b?.token) return fail("missing_token", 422);
  try {
    const auth = await acceptInvite(b.token, b.name ?? "", b.password);
    return withSessionCookie(ok({ ...auth, token: auth.session.token }), auth.session.token);
  } catch (e: any) {
    return fail(e.message ?? "accept_failed", e.status ?? 401);
  }
}
