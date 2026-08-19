/**
 * GET /api/phone-intel/companies
 * The Corporate Telephone Routing Graph for this workspace: every mapped
 * company with its cached route + confidence (spec §29-30, §60-61). Read-only.
 */

import { requireSession, ok } from "../../../../lib/api";
import { ensureIntelReady, listProfiles, activeRoute } from "../../../../lib/phoneintel/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  await ensureIntelReady();
  const ws = g.ctx.workspace.id;
  const companies = listProfiles(ws).map((p) => {
    const route = activeRoute(ws, p.companyKey);
    return {
      companyKey: p.companyKey,
      companyName: p.companyName,
      domain: p.domain,
      mainPhone: p.mainPhone,
      systemType: p.systemType,
      directoryAvailable: p.directoryAvailable,
      directorySpec: p.directorySpec,
      knownRoute: p.knownRoute,
      routeConfidence: p.routeConfidence,
      lastVerifiedAt: p.lastVerifiedAt,
      route: route ? { version: route.version, steps: route.steps, timesUsed: route.timesUsed, timesSucceeded: route.timesSucceeded } : null,
    };
  });
  return ok({ companies });
}
