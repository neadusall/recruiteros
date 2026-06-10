/**
 * Custom-domain lifecycle for a workspace (white-label "their domain").
 *
 * GET  /api/branding/domain                  -> current domain + DNS instructions
 * POST /api/branding/domain { action, domain }
 *   set    -> store the domain (status pending) + return the CNAME/TXT records
 *   verify -> DNS-check the TXT token; on success status -> verified
 *   remove -> clear the domain (back to the house host)
 *
 * Writes require accounts:manage (admin/owner). The actual host->workspace serving
 * + TLS is wired at the edge/deploy layer; this owns the domain record + ownership.
 */

import {
  getBranding,
  domainInstructions,
  setCustomDomain,
  verifyCustomDomain,
  clearCustomDomain,
} from "../../../../lib/branding";
import { requireCapability, body, ok, fail } from "../../../../lib/api";

export async function GET(req: Request) {
  const g = requireCapability(req, "accounts:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  return ok({ branding: await getBranding(ws), instructions: await domainInstructions(ws) });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "accounts:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{ action?: string; domain?: string }>(req);

  try {
    switch (b?.action) {
      case "set":
        if (!b.domain) return fail("missing_domain", 422);
        return ok(await setCustomDomain(ws, b.domain));
      case "verify":
        return ok(await verifyCustomDomain(ws));
      case "remove":
        return ok({ branding: await clearCustomDomain(ws), instructions: null });
      default:
        return fail("unknown_action", 400);
    }
  } catch (e: any) {
    return fail(e?.message || "domain_error", 422);
  }
}
