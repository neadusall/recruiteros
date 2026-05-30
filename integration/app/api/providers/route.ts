/**
 * GET  /api/providers -> configured-status of every integration provider
 * POST /api/providers -> { action: "verify-all" } runs a live health check on all
 *
 * One place to confirm every integration is wired and which keys are still
 * missing. Powers a diagnostics view and the Connected "Test all" button.
 */

import { providerStatuses, verifyAll } from "../../../lib/providers";
import { requireCapability, body, ok } from "../../../lib/api";

export async function GET(req: Request) {
  const g = requireCapability(req, "integrations:manage");
  if ("response" in g) return g.response;
  const statuses = providerStatuses();
  return ok({
    providers: statuses,
    configured: statuses.filter((s) => s.configured).length,
    total: statuses.length,
  });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "integrations:manage");
  if ("response" in g) return g.response;
  const b = await body<{ action?: string }>(req);
  if (b?.action === "verify-all") {
    return ok({ results: await verifyAll() });
  }
  return ok({ providers: providerStatuses() });
}
