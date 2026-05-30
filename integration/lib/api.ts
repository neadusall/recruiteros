/**
 * RecruiterOS · API helpers
 * Thin glue every route shares: JSON parsing, the authed workspace context,
 * and a session cookie. Keeps the route handlers to a few lines each.
 */

import { NextResponse } from "next/server";
import { sessionContext, tokenFromRequest, type AuthResult } from "./auth";

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

/** Set the session cookie on a response (HttpOnly, 14d). */
export function withSessionCookie(res: NextResponse, token: string): NextResponse {
  res.headers.append(
    "Set-Cookie",
    `ros_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}`,
  );
  return res;
}
