/**
 * GET /api/owner/enter -> 302 to the Owner Console at its secret slug.
 *
 * The console is published only at an unguessable slug (see sync-public.cjs) and
 * that slug never appears in any public page. This route is the stable, gated
 * doorway: it checks the OWNER_EMAIL allow-list server-side and, only for an
 * owner, redirects to the live slug. Everyone else gets a 404 — the console's
 * existence isn't even confirmed. Mirrors /api/ostext/enter.
 */

import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { requireOwner } from "../../../../lib/api";

function ownerSlug(): string | null {
  const fromEnv = (process.env.OWNER_CONSOLE_SLUG || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (fromEnv) return fromEnv;
  try {
    const s = readFileSync(join(process.cwd(), ".owner-console-slug"), "utf8").trim();
    if (s) return s;
  } catch {
    /* file absent (e.g. local dev without a build) -> fall through to 404 */
  }
  return null;
}

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response; // 404 for non-owners / unauthenticated
  const slug = ownerSlug();
  if (!slug) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.redirect(new URL("/" + slug + ".html", req.url), 302);
}
