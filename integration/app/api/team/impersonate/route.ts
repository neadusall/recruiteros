/**
 * POST /api/team/impersonate  Body: { userId }
 * Admin "view as recruiter": mint a session for one recruiter in the actor's
 * workspace and return it in the body (NOT as a cookie), so the admin's own
 * session is untouched. The Admin Portal hands this token to a single recruiter
 * tab, which sends it as a Bearer header. Gated by team:manage; the target must
 * be a recruiter (role "member") in the same workspace.
 */

import { impersonateMember } from "../../../../lib/auth/team";
import { requireCapability, body, ok, fail } from "../../../../lib/api";

export async function POST(req: Request) {
  const g = requireCapability(req, "team:manage");
  if ("response" in g) return g.response;
  const b = await body<{ userId?: string }>(req);
  if (!b?.userId) return fail("missing_userId", 422);
  try {
    const auth = impersonateMember(g.ctx.workspace.id, b.userId);
    // No Set-Cookie on purpose: the admin's cookie session must stay intact.
    return ok({ ...auth, token: auth.session.token });
  } catch (e: any) {
    return fail(e.message ?? "impersonate_failed", e.status ?? 400);
  }
}
