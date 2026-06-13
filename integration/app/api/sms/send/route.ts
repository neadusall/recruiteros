/**
 * POST /api/linkedin/../sms/send  ->  POST /api/sms/send
 * Send a single SMS through the texting platform.
 *
 * Body: { from, to, text, ref? }
 * Used by RecruitersOS to fire a text from a campaign, a sequence step, or a
 * manual recruiter action. The same provider powers AI auto-replies.
 */

import { NextResponse } from "next/server";
import { getSmsProvider } from "../../../../lib/sms/provider";
import { requireAuth } from "../../../../lib/linkedin/auth";
import { getCore } from "../../../../lib/core/repository";

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if (!auth.ok) return auth.response;

  let body: {
    from?: string; to?: string; text?: string;
    ref?: { campaignId?: string; prospectId?: string; threadId?: string };
    /** Optional motion hint; BD never sends SMS by policy. */
    motion?: string;
  };
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

  // BD policy: SMS is disabled for the business-development motion. Block if the
  // caller flags BD, or if the referenced prospect is a BD prospect.
  let motion = body.motion;
  if (!motion && body.ref?.prospectId) {
    motion = (await getCore().getProspect(body.ref.prospectId))?.motion;
  }
  if (motion === "bd") {
    return NextResponse.json(
      { error: "sms_disabled_for_bd", detail: "SMS is not used in the BD motion (use LinkedIn voice notes or voicemail drops)." },
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
