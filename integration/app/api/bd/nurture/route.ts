/**
 * GET  /api/bd/nurture?ws=<id>   -> nurture enrollments (status counts + each lead's
 *                                   stage, next-due, and any staged LinkedIn touches)
 * POST /api/bd/nurture
 *   { action: "pause"|"resume"|"complete", prospectId } -> change one enrollment's status
 *
 * Bearer-authed (RECRUITEROS_API_TOKEN). Flow D (reply / opt-out webhook) calls
 * `pause` so we stop nurturing anyone who replied or unsubscribed. The GET view
 * surfaces the generated-but-unsent LinkedIn comment / voice-note touches.
 */

import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/linkedin/auth";
import { ensureNurtureReady, listEnrollments, setStatus, getEnrollment, type NurtureStatus } from "../../../../lib/bd/nurture";

export async function GET(req: Request) {
  const auth = requireAuth(req);
  if (!auth.ok) return auth.response;
  await ensureNurtureReady();

  const ws = new URL(req.url).searchParams.get("ws") ?? undefined;
  const enrollments = listEnrollments(ws);
  const counts = enrollments.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    ok: true,
    counts,
    total: enrollments.length,
    enrollments: enrollments.map((e) => ({
      prospectId: e.prospectId,
      status: e.status,
      hold: e.hold,
      title: e.lead.title,
      company: e.lead.company,
      touchesSent: e.touchesSent,
      nextTouchIndex: e.nextTouchIndex,
      nextDueAt: e.nextDueAt,
      pending: e.pending,
    })),
  });
}

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if (!auth.ok) return auth.response;
  await ensureNurtureReady();

  let body: { action?: string; prospectId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const valid: NurtureStatus[] = ["paused", "active", "completed"];
  const map: Record<string, NurtureStatus> = { pause: "paused", resume: "active", complete: "completed" };
  const status = body.action ? map[body.action] : undefined;
  if (!body.prospectId || !status || !valid.includes(status)) {
    return NextResponse.json({ error: "bad_request", detail: "prospectId + action (pause|resume|complete) required" }, { status: 422 });
  }
  if (!getEnrollment(body.prospectId)) {
    return NextResponse.json({ error: "not_enrolled" }, { status: 404 });
  }

  setStatus(body.prospectId, status);
  return NextResponse.json({ ok: true, prospectId: body.prospectId, status });
}
