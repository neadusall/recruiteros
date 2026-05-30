/**
 * GET  /api/accounts -> LinkedIn accounts + sending domains + API keys + platforms
 * POST /api/accounts -> add one of: linkedin | domain | apikey, or run health sweep
 */

import {
  addLinkedInAccount, listLinkedInAccounts, addDomain, listDomains,
  addApiKey, listApiKeys, runHealthSweep, LINKEDIN_PLATFORMS, type LinkedInPlatform,
} from "../../../lib/accounts";
import { requireCapability, body, ok, fail } from "../../../lib/api";

export async function GET(req: Request) {
  const g = requireCapability(req, "accounts:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  return ok({
    linkedin: listLinkedInAccounts(ws),
    domains: listDomains(ws),
    apiKeys: listApiKeys(ws),
    platforms: LINKEDIN_PLATFORMS,
  });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "accounts:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);

  switch (b?.type) {
    case "linkedin":
      if (!b.handle) return fail("missing_handle", 422);
      return ok({ account: addLinkedInAccount(ws, b.handle, (b.platform as LinkedInPlatform) ?? "unipile") }, 201);
    case "domain":
      if (!b.domain) return fail("missing_domain", 422);
      return ok({ domain: addDomain(ws, b.domain, b.inboxes ?? 3) }, 201);
    case "apikey":
      if (!b.service || !b.key) return fail("missing_fields", 422);
      return ok({ key: addApiKey(ws, b.service, b.key) }, 201);
    case "health-sweep":
      return ok({ alerts: runHealthSweep(ws, b.vitals) });
    default:
      return fail("unknown_type", 400);
  }
}
