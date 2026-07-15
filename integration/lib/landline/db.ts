import { Pool } from "pg";
import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { requireOwner, fail } from "../api";

// LandlineDB lives in its own database inside the compose Postgres service.
// Never mixed with app data; the app only reads it here.
function url(): string {
  return (
    process.env.LANDLINEDB_URL ||
    `postgres://recruiteros:${process.env.POSTGRES_PASSWORD || ""}@db:5432/landlinedb`
  );
}

const g = globalThis as unknown as { __landlinePool?: Pool };
export function landlineDb(): Pool {
  if (!g.__landlinePool) g.__landlinePool = new Pool({ connectionString: url(), max: 5 });
  return g.__landlinePool;
}

function keyOk(req: Request): boolean {
  const expected = process.env.LANDLINEDB_KEY || "";
  if (!expected) return false;
  const got =
    req.headers.get("x-landlinedb-key") ||
    new URL(req.url).searchParams.get("key") ||
    "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "X-LandlineDB-Key, Content-Type",
  };
}

export function corsPreflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

/**
 * Access = valid LANDLINEDB_KEY (works from any host, so the UI is portable)
 * OR a logged-in owner session. Everyone else gets 404 (owner-console precedent:
 * the module does not admit it exists).
 */
export function guardLandline(req: Request): { response: NextResponse } | { ok: true } {
  if (keyOk(req)) return { ok: true };
  const o = requireOwner(req);
  if ("response" in o) return { response: fail("not_found", 404) };
  return { ok: true };
}
