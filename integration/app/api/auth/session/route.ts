/**
 * GET    /api/auth/session  -> current authed context (or 401)
 * DELETE /api/auth/session  -> sign out
 */

import { logout, tokenFromRequest } from "../../../../lib/auth";
import { context, ok, fail } from "../../../../lib/api";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const ctx = context(req);
  return ctx ? ok(ctx) : fail("unauthorized", 401);
}

export async function DELETE(req: Request) {
  const token = tokenFromRequest(req);
  if (token) logout(token);
  const res = NextResponse.json({ ok: true });
  res.headers.append("Set-Cookie", "ros_session=; Path=/; HttpOnly; Max-Age=0");
  return res;
}
