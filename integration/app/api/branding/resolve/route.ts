/**
 * GET /api/branding/resolve?host=app.lumesp.com -> public branding for that host
 *
 * Unauthenticated on purpose: the login/signup pages call this on a custom domain
 * to brand themselves BEFORE anyone signs in. Returns logo + name only (nothing
 * sensitive). Falls back to the request's own Host header when no ?host is given.
 */

import { publicBrandingForHost } from "../../../../lib/branding";
import { ok } from "../../../../lib/api";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const host = url.searchParams.get("host") || req.headers.get("host") || "";
  const branding = host ? await publicBrandingForHost(host) : null;
  return ok({ branding: branding || {} });
}
