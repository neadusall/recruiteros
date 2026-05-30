/**
 * POST /api/linkedin/../sms/send  ->  POST /api/sms/send
 * Send a single SMS through the texting platform.
 *
 * Body: { from, to, text, ref? }
 * Used by RecruiterOS to fire a text from a campaign, a sequence step, or a
 * manual recruiter action. The same provider powers AI auto-replies.
 */

import { NextResponse } from "next/server";
import { getSmsProvider } from "../../../../lib/sms/provider";
import { requireAuth } from "../../../../lib/linkedin/auth";

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if (!auth.ok) return auth.response;

  let body: { from?: string; to?: string; text?: string; ref?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.from || !body.to || !body.text) {
    return NextResponse.json(
      { error: "missing_fields", detail: "from, to and text are required" },
      { status: 422 },
    );
  }

  const result = await getSmsProvider().send({
    from: body.from,
    to: body.to,
    text: body.text,
    ref: body.ref as any,
  });

  return NextResponse.json({ result }, { status: result.ok ? 200 : 502 });
}
