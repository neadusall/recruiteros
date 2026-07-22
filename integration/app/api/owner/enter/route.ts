/**
 * GET /api/owner/enter -> 302 to the Owner Console at /owner-console.
 *
 * The console lives at a single clean URL (/owner-console). The real lock is the
 * OWNER_EMAIL allow-list, checked server-side on every /api/owner/* call, so a
 * logged-out or non-owner visitor sees no data. This route is the stable, gated
 * doorway: it confirms the caller is an owner first, then forwards to the
 * console; everyone else gets a 404. Mirrors /api/ostext/enter.
 */

import { NextResponse } from "next/server";
import { requireOwner } from "../../../../lib/api";

/**
 * The PUBLIC origin this request came in on. Behind the Caddy reverse proxy the
 * Next container only sees the internal URL (http://localhost:3000), so a
 * redirect built from req.url would bounce the browser to localhost. Caddy
 * forwards the real host/scheme in x-forwarded-*, so rebuild the origin from
 * those, falling back to the configured app URL, and only to req.url as a last
 * resort (e.g. direct local dev with no proxy).
 */
function publicOrigin(req: Request): string {
  const fwdHost = (req.headers.get("x-forwarded-host") || "").split(",")[0].trim();
  const host = fwdHost || (req.headers.get("host") || "").trim();
  const proto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim() || "https";
  // Ignore the internal proxy target so we never emit a localhost redirect.
  if (host && !/^localhost(:\d+)?$/i.test(host) && !/^127\.0\.0\.1(:\d+)?$/.test(host)) {
    return `${proto}://${host}`;
  }
  return process.env.RECRUITEROS_APP_URL || new URL(req.url).origin;
}

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response; // 404 for non-owners / unauthenticated
  return NextResponse.redirect(new URL("/owner-console", publicOrigin(req)), 302);
}
