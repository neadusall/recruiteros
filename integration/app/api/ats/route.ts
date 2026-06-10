/**
 * GET  /api/ats  -> ATS vendor catalog + the Loxo object mapping + this
 *                   workspace's saved (masked) connection config.
 * POST /api/ats  -> { action, vendor, ... }
 *   save              { domain, slug, apiKey, webhookSecret? }  store credentials
 *   test              {}                                        live-verify the connection
 *   set-active        {}                                        choose system of record
 *   sync              { full? }                                 pull People + Companies now
 *   register-webhooks {}                                        subscribe to Loxo real-time feed
 *   disconnect        {}                                        forget this vendor's credentials
 *
 * All admin-gated (ats:manage). Credentials are stored per-workspace (never in
 * server env) so each workspace connects its own ATS account from the portal.
 */

import {
  ATS_VENDORS,
  LOXO_OBJECT_MAP,
  publicConfig,
  saveVendorConfig,
  setActiveVendor,
  disconnectVendor,
  testLoxo,
  syncLoxo,
  registerLoxoWebhooks,
  type AtsVendor,
} from "../../../lib/ats";
import { requireCapability, body, ok, fail } from "../../../lib/api";

export async function GET(req: Request) {
  const g = requireCapability(req, "ats:manage");
  if ("response" in g) return g.response;
  const cfg = await publicConfig(g.ctx.workspace.id);
  return ok({
    vendors: ATS_VENDORS,
    objectMap: LOXO_OBJECT_MAP,
    active: cfg.active,
    config: cfg.vendors,
  });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "ats:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{
    action?: string;
    vendor?: AtsVendor;
    domain?: string;
    slug?: string;
    apiKey?: string;
    webhookSecret?: string;
    full?: boolean;
  }>(req);

  const vendor = (b?.vendor || "loxo") as AtsVendor;

  switch (b?.action) {
    case "save": {
      const cfg = await saveVendorConfig(ws, vendor, {
        domain: b?.domain,
        slug: b?.slug,
        apiKey: b?.apiKey,
        webhookSecret: b?.webhookSecret,
      });
      return ok({ saved: true, status: cfg.status, config: (await publicConfig(ws)).vendors });
    }

    case "test": {
      if (vendor !== "loxo") return fail("vendor_not_implemented", 501, { vendor });
      const res = await testLoxo(ws);
      return ok({ ok: res.ok, error: res.error, config: (await publicConfig(ws)).vendors });
    }

    case "set-active": {
      const okSet = await setActiveVendor(ws, vendor);
      return okSet ? ok({ active: vendor }) : fail("not_connected", 409, { vendor });
    }

    case "sync": {
      if (vendor !== "loxo") return fail("vendor_not_implemented", 501, { vendor });
      const report = await syncLoxo(ws, { full: Boolean(b?.full) });
      if (!report.ok) return fail(report.error || "sync_failed", 502, { report });
      return ok({ report, config: (await publicConfig(ws)).vendors });
    }

    case "register-webhooks": {
      if (vendor !== "loxo") return fail("vendor_not_implemented", 501, { vendor });
      const res = await registerLoxoWebhooks(ws, baseUrl(req));
      if (!res.registered) return fail(res.error || "webhook_register_failed", 502);
      return ok({ registered: res.registered });
    }

    case "disconnect": {
      await disconnectVendor(ws, vendor);
      return ok({ disconnected: vendor, config: (await publicConfig(ws)).vendors });
    }

    default:
      return fail("unknown_action", 400);
  }
}

/** Public origin of this deployment, for webhook callback URLs. */
function baseUrl(req: Request): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/+$/, "");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  return `${proto}://${host}`;
}
