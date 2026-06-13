/**
 * RecruitersOS · API helpers
 * Thin glue every route shares: JSON parsing, the authed workspace context,
 * and a session cookie. Keeps the route handlers to a few lines each.
 */

import { NextResponse } from "next/server";
import { sessionContext, tokenFromRequest, type AuthResult } from "./auth";
import { isOwnerEmail } from "./owner";

export function ok(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function fail(error: string, status = 400, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error, ...extra }, { status });
}

export async function body<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** Resolve the signed-in context, or null. */
export function context(req: Request): AuthResult | null {
  return sessionContext(tokenFromRequest(req));
}

/** Guard: require a session; returns the context or a 401 response. */
export function requireSession(req: Request): { ctx: AuthResult } | { response: NextResponse } {
  const ctx = context(req);
  if (!ctx) return { response: fail("unauthorized", 401) };
  return { ctx };
}

/**
 * Guard: require a session AND a capability. Recruiters hitting an admin-only
 * route (Telnyx, API keys, team, billing, ...) get a 403, not a 401.
 */
export function requireCapability(
  req: Request,
  cap: import("./auth/permissions").Capability,
): { ctx: AuthResult } | { response: NextResponse } {
  const g = requireSession(req);
  if ("response" in g) return g;
  if (!g.ctx.capabilities.includes(cap)) {
    return { response: fail("forbidden", 403, { needs: cap }) };
  }
  return g;
}

/**
 * Guard: require the OWNER. This is the hard wall on the owner console — a valid
 * session is not enough; the signed-in user's email must be on the OWNER_EMAIL
 * allow-list. Anyone else (including workspace admins) gets a 404-style 403 so
 * the console's existence isn't even confirmed.
 */
export function requireOwner(req: Request): { ctx: AuthResult } | { response: NextResponse } {
  const g = requireSession(req);
  if ("response" in g) return { response: fail("not_found", 404) };
  if (!isOwnerEmail(g.ctx.user.email)) return { response: fail("not_found", 404) };
  return g;
}

/** Set the session cookie on a response (HttpOnly, 14d). */
export function withSessionCookie(res: NextResponse, token: string): NextResponse {
  res.headers.append(
    "Set-Cookie",
    `ros_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}`,
  );
  return res;
}
