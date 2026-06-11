import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * White-label root guard.
 *
 * On the house domain (recruitersos.co / localhost) the bare root shows the
 * RecruitersOS marketing site (public/index.html via the /home redirect in
 * next.config.js). On a CUSTOMER's white-label domain (e.g. app.lumesp.com) that
 * marketing site must NEVER appear — the root is their product, not our pitch —
 * so the landing entry points are sent straight to the branded /login instead.
 *
 * The host test is intentionally the SAME shape as the in-page de-leak script in
 * login.html (recruitersos.co or any subdomain, localhost, 127.0.0.1, empty are
 * "house"; everything else is white-label) so the redirect and the de-leak never
 * disagree about what counts as a customer domain.
 */
export function middleware(req: NextRequest) {
  const host = (req.headers.get("host") || "").toLowerCase().split(":")[0];
  const isHouse = /(^|\.)recruitersos\.co$|^localhost$|^127\.0\.0\.1$|^$/.test(host);
  if (!isHouse) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Only the marketing landing entry points are guarded; the rest of the app
  // (/login, /admin, /recruiter, /signup, assets, API…) is untouched.
  matcher: ["/", "/home", "/index.html"],
};
