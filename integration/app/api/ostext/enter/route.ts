import { NextResponse } from "next/server";
import { requireSession } from "../../../../lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/ostext/enter
 *
 * Single sign-on into OS Text (taltxt). The portal's "OS Text" panel iframes
 * this. It is session-gated — you must already be signed into RecruiterOS — and
 * then 302-redirects the iframe into taltxt's instant-access link, which sets
 * taltxt's own session cookie and drops the user straight into the app. No
 * second login.
 *
 * The access token lives ONLY in this server's env (RECRUITEROS_OSTEXT_TOKEN),
 * so it never ships to the browser as static source: it appears only in the
 * redirect, and only for authenticated portal users. taltxt's own auth gate is
 * untouched, so the public can't reach OS Text directly.
 */
export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response; // not signed into the portal

  const base = (process.env.RECRUITEROS_OSTEXT_URL || "https://taltxt.recruitersos.co").replace(/\/$/, "");
  const token = process.env.RECRUITEROS_OSTEXT_TOKEN || "";

  // With a token, auto-sign-in via taltxt's instant-access route; without one,
  // just open the app (taltxt falls back to its own login).
  const dest = token
    ? base + "/api/enter?token=" + encodeURIComponent(token)
    : base + "/";

  return NextResponse.redirect(dest, 302);
}
