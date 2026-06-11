/**
 * GET /api/caddyask?domain=<host>   (UNAUTHENTICATED — called by Caddy only)
 *
 * Caddy's on-demand TLS "ask" endpoint. Before Caddy will obtain a Let's Encrypt
 * certificate for an arbitrary incoming host, it calls this and only proceeds on
 * a 2xx. We allow a host ONLY when it is a custom domain a workspace has added
 * AND DNS-verified (status "verified"/"live"), so nobody can trigger cert
 * issuance for a domain they don't control. The house domains never reach here —
 * they have explicit Caddyfile blocks.
 *
 * On the first allow we promote "verified" -> "live" so the owner console can see
 * which domains are actually being served.
 */

import { workspaceForDomain, getBranding, setBranding } from "../../../lib/branding";

export async function GET(req: Request) {
  const url = new URL(req.url);
  // Caddy sends ?domain=; fall back to the Host header just in case.
  const domain = (url.searchParams.get("domain") || req.headers.get("host") || "")
    .trim()
    .toLowerCase();

  if (!domain || !domain.includes(".")) {
    return new Response("no domain", { status: 400 });
  }

  const workspaceId = await workspaceForDomain(domain);
  if (!workspaceId) return new Response("unknown domain", { status: 403 });

  const b = await getBranding(workspaceId);
  if (b.domainStatus !== "verified" && b.domainStatus !== "live") {
    return new Response("domain not verified", { status: 403 });
  }

  // First time we serve it: mark it live (best-effort; never blocks the allow).
  if (b.domainStatus === "verified") {
    try { await setBranding(workspaceId, { domainStatus: "live" }); } catch {}
  }

  return new Response("ok", { status: 200 });
}
