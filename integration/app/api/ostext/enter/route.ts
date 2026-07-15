import { NextResponse } from "next/server";
import { requireSession } from "../../../../lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/ostext/enter
 *
 * Single sign-on into OS Text (the embedded SMS engine). The portal's "OS Text"
 * panel iframes this. It is session-gated (you must already be signed into the
 * portal) and then 302-redirects the iframe into the engine's instant-access
 * link, which sets the engine's own session cookie and drops the user straight
 * into the app. No second login.
 *
 * SAME-ORIGIN BY DESIGN: the engine is served under /ostext-app on THIS host
 * (Caddy proxies it to the engine container on every portal domain, house and
 * white-label alike). The user never leaves recruitersos.co or their own
 * white-label domain, the iframe cookie is always first-party, and no house
 * URL can leak into a customer's browser bar.
 *
 * The access token lives ONLY in this server's env (RECRUITEROS_OSTEXT_TOKEN),
 * so it never ships to the browser as static source: it appears only in the
 * redirect, and only for authenticated portal users. The engine's own auth gate
 * is untouched, so the public can't reach OS Text directly.
 *
 * ?theme=dark|light and ?accent=#rrggbb are forwarded so the engine paints in
 * the surrounding portal's exact skin (including white-label accents).
 */
export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response; // not signed into the portal

  const url = new URL(req.url);
  const token = process.env.RECRUITEROS_OSTEXT_TOKEN || "";

  // Same-origin path into the engine, ALWAYS, in production. The old
  // RECRUITEROS_OSTEXT_URL (which pointed at the legacy taltxt subdomain) is
  // intentionally ignored; RECRUITEROS_OSTEXT_DEV_URL is the local-dev-only
  // absolute override for pointing at a locally-run engine.
  const override = (process.env.RECRUITEROS_OSTEXT_DEV_URL || "").replace(/\/$/, "");
  const dest = override
    ? new URL(override + (token ? "/api/enter" : "/"))
    : new URL(token ? "/ostext-app/api/enter" : "/ostext-app/", req.url);

  if (token) dest.searchParams.set("token", token);
  // Forward the signed-in recruiter's identity so the engine signs each person
  // in as themselves (per-user identity) rather than one shared account. Only
  // meaningful with the token; the engine validates it before trusting these.
  const who = g.ctx.user;
  if (token && who?.email) dest.searchParams.set("email", who.email);
  if (token && who?.name) dest.searchParams.set("name", who.name);
  const theme = url.searchParams.get("theme");
  const accent = url.searchParams.get("accent");
  if (theme === "dark" || theme === "light") dest.searchParams.set("theme", theme);
  if (accent && /^#[0-9a-fA-F]{3,8}$/.test(accent)) dest.searchParams.set("accent", accent);

  return NextResponse.redirect(dest, 302);
}
