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
  const pathname = req.nextUrl.pathname;

  // Short video watch links: `vid.<yourdomain>/v/<code>` → the branded watch page. The `/v/`
  // namespace can never collide with an app route, so this is safe on ANY host; the brand + TidyCal
  // calendar resolve from the host inside the watch page. Works the same on the house domain.
  const v = pathname.match(/^\/v\/([A-Za-z0-9_-]{4,40})\/?$/);
  if (v) {
    const url = req.nextUrl.clone();
    url.pathname = "/watch";
    url.searchParams.set("s", v[1]);   // preserve any per-recipient params (n, rcpt, pe) and add the code
    return NextResponse.rewrite(url);
  }

  // Internal engineering dashboards (dev console, project map) enumerate the
  // whole vendor stack. They are never part of the product on ANY host, so the
  // static files are unreachable: every request bounces to the sign-in page.
  if (/^\/(dev-console|project-map)(\.html)?\/?$/.test(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // White-label root guard (unchanged): a customer's white-label root shows their product, not our pitch.
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
  // The marketing landing entry points (root guard) + short video watch links (/v/<code>).
  // The rest of the app (/login, /admin, /recruiter, /signup, assets, API…) is untouched.
  matcher: ["/", "/home", "/index.html", "/v/:code*", "/dev-console", "/dev-console.html", "/project-map", "/project-map.html"],
};
