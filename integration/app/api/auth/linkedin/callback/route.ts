/**
 * GET /api/auth/linkedin/callback
 * LinkedIn redirects here with ?code=...&state=.... We exchange the code for an
 * access token, read the OpenID Connect userinfo (name, email, picture), then
 * sign the user in (creating their workspace if new) and drop them in /command.
 */

import { NextResponse } from "next/server";
import { upsertOAuthUser } from "../../../../../lib/auth";

function fail(msg: string) {
  // Send the user back to login with a readable error, not a JSON blob.
  return NextResponse.redirect(
    (process.env.RECRUITEROS_APP_URL || "") + "/login?error=" + encodeURIComponent(msg),
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookie = req.headers.get("cookie") || "";
  const savedState = (cookie.match(/(?:^|;\s*)li_state=([^;]+)/) || [])[1];

  if (!code) return fail("linkedin_no_code");
  if (!state || !savedState || state !== savedState) return fail("linkedin_bad_state");

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail("linkedin_not_configured");

  const base = (process.env.RECRUITEROS_APP_URL || url.origin).replace(/\/$/, "");
  const redirectUri = base + "/api/auth/linkedin/callback";

  try {
    // 1) Exchange the authorization code for an access token.
    const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const token = await tokenRes.json();
    if (!tokenRes.ok || !token.access_token) return fail("linkedin_token_failed");

    // 2) Fetch the OpenID Connect profile (name, email, picture).
    const meRes = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: "Bearer " + token.access_token },
    });
    const me = await meRes.json();
    if (!meRes.ok || !me.email) return fail("linkedin_profile_failed");

    // 3) Sign in / sign up, capturing the LinkedIn identity.
    const auth = await upsertOAuthUser({
      email: me.email,
      name: me.name || [me.given_name, me.family_name].filter(Boolean).join(" "),
      picture: me.picture,
      // OIDC doesn't return the public profile URL; store the stable member id
      // so the Alfred extension can match the same account.
      linkedinUrl: me.sub ? "linkedin:" + me.sub : undefined,
    });

    // 4) Land in the portal with the session cookie set.
    const res = NextResponse.redirect(base + "/command");
    res.headers.append(
      "Set-Cookie",
      `ros_session=${encodeURIComponent(auth.session.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}`,
    );
    // Clear the state cookie.
    res.headers.append("Set-Cookie", "li_state=; Path=/; Max-Age=0");
    return res;
  } catch (e) {
    return fail("linkedin_error");
  }
}
