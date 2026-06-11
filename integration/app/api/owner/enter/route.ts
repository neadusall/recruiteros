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
  return NextResponse.redirect(new URL("/owner-console", req.url), 302);
}
