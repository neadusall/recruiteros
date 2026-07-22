/**
 * POST /api/auth/change-password  (session-gated)
 * Body: { currentPassword?, newPassword }
 *
 * Lets a signed-in user rotate their own password from inside the portal, with
 * no email round-trip, the fix for white-label tenants (e.g. Lume) whose
 * branded reset mail can't send. Verifies the current password (skipped for a
 * passwordless account setting its first one), then revokes every OTHER session
 * so other devices are logged out while THIS one stays signed in.
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";
import { changePassword, tokenFromRequest } from "../../../../lib/auth";

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<{ currentPassword?: string; newPassword?: string }>(req);
  if (!b?.newPassword) return fail("missing_new_password", 422);
  try {
    await changePassword(
      g.ctx.user.id,
      b.currentPassword ?? "",
      b.newPassword,
      tokenFromRequest(req) ?? undefined,
    );
    return ok({ changed: true });
  } catch (e: any) {
    return fail(e.message ?? "change_failed", e.status ?? 400);
  }
}
