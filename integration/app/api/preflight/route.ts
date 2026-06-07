/**
 * GET /api/preflight — readiness report: what's wired vs. what the owner still
 * needs to do. Reports env presence only (never secret values). Session-gated so
 * the configured/not-configured map isn't public.
 */

import { requireSession, ok } from "../../../lib/api";
import { readiness } from "../../../lib/preflight";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  return ok(readiness(new Date().toISOString()));
}
