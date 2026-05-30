/**
 * GET  /api/team -> members + pending invites + which roles you can assign
 * POST /api/team -> admin actions (all require the team:manage capability):
 *   { action: "invite", email, role }
 *   { action: "setRole", userId, role }
 *   { action: "remove", userId }
 *
 * This is the admin sub-account console: add recruiters, set their role, remove
 * them. Recruiters (members) lack team:manage and get a 403.
 */

import { listMembers, listInvites, inviteMember, setRole, removeMember } from "../../../lib/auth/team";
import { ASSIGNABLE_ROLES } from "../../../lib/auth/permissions";
import { requireCapability, body, ok, fail } from "../../../lib/api";
import type { Role } from "../../../lib/auth/types";

export async function GET(req: Request) {
  const g = requireCapability(req, "team:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  return ok({
    members: listMembers(ws, g.ctx.user.id),
    invites: listInvites(ws),
    assignableRoles: ASSIGNABLE_ROLES[g.ctx.role],
  });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "team:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{ action?: string; email?: string; role?: Role; userId?: string }>(req);

  try {
    switch (b?.action) {
      case "invite":
        if (!b.email || !b.role) return fail("missing_fields", 422);
        return ok(await inviteMember(g.ctx.role, g.ctx.user.name, ws, b.email, b.role), 201);
      case "setRole":
        if (!b.userId || !b.role) return fail("missing_fields", 422);
        return ok({ members: setRole(g.ctx.role, ws, b.userId, b.role) });
      case "remove":
        if (!b.userId) return fail("missing_userId", 422);
        if (b.userId === g.ctx.user.id) return fail("cannot_remove_self", 409);
        return ok({ members: removeMember(ws, b.userId) });
      default:
        return fail("unknown_action", 400);
    }
  } catch (e: any) {
    return fail(e.message ?? "team_action_failed", e.status ?? 400);
  }
}
