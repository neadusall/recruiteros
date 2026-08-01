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

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response; // 404 for non-owners / unauthenticated
  // Relative Location on purpose: the browser resolves it against the URL IT
  // requested (https://recruitersos.co/...), so owners land on the public site.
  // new URL("/owner-console", req.url) would use req.url, which behind the Caddy
  // reverse proxy is the app's INTERNAL address (http://localhost:3000) — that
  // bounced owners to localhost:3000/owner-console after login. A relative
  // redirect never depends on the internal address or forwarded headers.
  return new NextResponse(null, { status: 302, headers: { Location: "/owner-console" } });
}
