/**
 * GET /api/team/search?q=<name>  -> { members }
 * Find recruiters in the caller's workspace by first name, last name, or email.
 * Empty q returns everyone. Any logged-in member may search (needed to pick a
 * recruiter when assigning a sender pool to a campaign).
 */
import { searchMembers } from "../../../../lib/auth/team";
import { requireSession, ok } from "../../../../lib/api";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  const q = url.searchParams.get("q") || "";
  return ok({ members: searchMembers(g.ctx.workspace.id, q, g.ctx.user.id) });
}
