/**
 * GET /api/branding/allowed?domain=app.lumesp.com -> 200 if we should serve it
 *
 * The authorization endpoint for Caddy's on-demand TLS (`tls { on_demand }` +
 * global `on_demand_tls { ask … }`). Caddy calls this with the SNI host before
 * issuing a Let's Encrypt cert; a 2xx means "yes, mint a cert for this host".
 *
 * We return 200 ONLY for hosts a workspace has actually claimed as its custom
 * domain (and for our own apex/known hosts), so nobody can point an arbitrary
 * domain at the server and exhaust our cert rate limits. Unauthenticated on
 * purpose — Caddy calls it server-side with no session.
 */

import { workspaceForDomain, normalizeDomain } from "../../../../lib/branding";

// Our own first-party hosts always allowed (also covered by explicit Caddy
// blocks, but harmless to allow here too).
const HOUSE_HOSTS = new Set(["recruitersos.co", "www.recruitersos.co", "taltxt.recruitersos.co"]);

export async function GET(req: Request) {
  const host = normalizeDomain(new URL(req.url).searchParams.get("domain") || "");
  if (!host) return new Response("no domain", { status: 400 });
  if (HOUSE_HOSTS.has(host)) return new Response("ok", { status: 200 });
  const ws = await workspaceForDomain(host);
  return ws
    ? new Response("ok", { status: 200 })
    : new Response("unknown domain", { status: 404 });
}
