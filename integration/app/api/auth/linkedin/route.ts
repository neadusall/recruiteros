/**
 * GET /api/auth/linkedin
 * Starts "Sign in with LinkedIn" (OpenID Connect). Redirects the user to
 * LinkedIn's authorize screen. On approval, LinkedIn sends them back to
 * /api/auth/linkedin/callback.
 *
 * Requires env: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, and (optionally)
 * RECRUITEROS_APP_URL for the redirect base.
 */

import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

export async function GET(req: Request) {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "linkedin_not_configured" }, { status: 503 });
  }
  const base = process.env.RECRUITEROS_APP_URL || new URL(req.url).origin;
  const redirectUri = base.replace(/\/$/, "") + "/api/auth/linkedin/callback";
  const state = randomBytes(16).toString("hex");

  const authUrl =
    "https://www.linkedin.com/oauth/v2/authorization?response_type=code" +
    "&client_id=" + encodeURIComponent(clientId) +
    "&redirect_uri=" + encodeURIComponent(redirectUri) +
    "&state=" + state +
    "&scope=" + encodeURIComponent("openid profile email");

  const res = NextResponse.redirect(authUrl);
  // Short-lived, signed-ish state cookie to defend against CSRF on callback.
  res.headers.append(
    "Set-Cookie",
    `li_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
  );
  return res;
}
