/**
 * GET|POST /api/linkedin/os/cron
 * Manual / redundant external trigger for the LinkedIn OS shared engine tick
 * (the in-process automation clock is the primary driver). Guarded by the
 * shared cron secret like every other cron endpoint.
 */

import { NextResponse } from "next/server";
import { requireCronAuth } from "../../../../../lib/linkedin/auth";
import { tickLinkedInOs } from "../../../../../lib/linkedin/os/executor";

async function run(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;
  const out = await tickLinkedInOs();
  return NextResponse.json({ ok: true, ...out });
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }
