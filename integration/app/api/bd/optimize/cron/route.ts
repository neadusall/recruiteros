/**
 * POST or GET /api/bd/optimize/cron?ws=<id>
 * Drives the self-learning outreach loop for one workspace: scores every
 * methodology by positive-reply rate + significance, promotes a challenger that
 * beats the champion, retires confident losers, spawns fresh challengers, and
 * writes the winning content into the live sequence. Idempotent + safe to call
 * repeatedly. Call it a few times a day (or let the daily cadence run it via
 * refreshAutopilots — this cron just lets you optimize on a tighter cadence).
 *
 * Auth: x-cron-secret (RECRUITEROS_CRON_SECRET), matching the other cron ticks.
 */

import { NextResponse } from "next/server";
import { requireCronAuth } from "../../../../../lib/linkedin/auth";
import { optimizeAll } from "../../../../../lib/bd/optimizer";

async function run(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;

  const ws = new URL(req.url).searchParams.get("ws") ?? "";
  if (!ws) return NextResponse.json({ error: "missing_workspace", detail: "?ws= is required" }, { status: 422 });

  const results = await optimizeAll(ws);
  const actions = results.reduce((n, r) => n + r.actions.length, 0);
  return NextResponse.json({ ok: true, workspaceId: ws, actions, results });
}

export const GET = run;
export const POST = run;
