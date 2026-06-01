/**
 * RecruiterOS · LinkedIn Engine
 * Auth helpers for the API surface.
 *
 *  - requireAuth: bearer token for calls from the RecruiterOS backend.
 *  - requireCronAuth: shared secret for the scheduler.
 *  - verifyProviderSignature: HMAC check on inbound provider webhooks.
 */

import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

// The optional `response` on the success branch keeps `auth.response` a valid
// access without relying on control-flow narrowing, which the project's
// non-strict tsconfig (strict:false) does not apply to discriminated unions.
type Guard = { ok: true; response?: undefined } | { ok: false; response: NextResponse };

export function requireAuth(req: Request): Guard {
  const token = bearer(req);
  const expected = process.env.RECRUITEROS_API_TOKEN;
  if (!expected) return { ok: false, response: json("server_misconfigured", 500) };
  if (!token || !safeEq(token, expected)) {
    return { ok: false, response: json("unauthorized", 401) };
  }
  return { ok: true };
}

export function requireCronAuth(req: Request): Guard {
  const url = new URL(req.url);
  const secret = req.headers.get("x-cron-secret") ?? url.searchParams.get("secret") ?? "";
  const expected = process.env.RECRUITEROS_CRON_SECRET;
  if (!expected) return { ok: false, response: json("server_misconfigured", 500) };
  if (!safeEq(secret, expected)) return { ok: false, response: json("unauthorized", 401) };
  return { ok: true };
}

/** Verify the provider webhook HMAC signature over the raw body. */
export function verifyProviderSignature(req: Request, rawBody: string): boolean {
  const secret = process.env.UNIPILE_WEBHOOK_SECRET;
  if (!secret) return true; // allow if not configured (dev); set in production
  const sig = req.headers.get("x-unipile-signature") ?? "";
  const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEq(sig, digest);
}

/* helpers */
function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}
function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
function json(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}
