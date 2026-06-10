/**
 * GET /api/overview -> the real-time dashboard snapshot for the workspace.
 */

import { overview } from "../../../lib/overview";
import { requireSession, ok } from "../../../lib/api";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  const m = url.searchParams.get("motion");
  const motion = m === "bd" ? "bd" : m === "recruiting" ? "recruiting" : undefined;
  // Per-recruiter drill-down is admin-only: a recruiter can never scope the
  // dashboard to someone else. Admins (team:manage) may pass ?recruiter=<userId>.
  let ownerId: string | undefined;
  const requested = url.searchParams.get("recruiter") ?? undefined;
  if (requested) {
    ownerId = g.ctx.capabilities.includes("team:manage") ? requested : g.ctx.user.id;
  }
  return ok(await overview(g.ctx.workspace.id, { motion, ownerId }));
}
