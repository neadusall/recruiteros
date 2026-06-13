/**
 * POST /api/email/send
 * Send one outreach email through the OWNED MTA (self-hosted Postal) sending
 * infrastructure — the server-to-server entry point the scheduler / n8n /
 * RecruitersOS backend calls to fire a single email. Mirrors /api/sms/send and
 * /api/voice/dial (bearer-authed via RECRUITEROS_API_TOKEN).
 *
 * Body: { workspaceId, prospect, subject, html, voiceCampaignId? }
 *   - prospect: a core Prospect (needs at least { id, email, firstName }).
 *   - html: the rendered email body (HTML); `text` is accepted as an alias.
 *   - voiceCampaignId: optional voice campaign to enqueue this prospect into for
 *     the reactive email-sent -> voicemail trigger (falls back to the env default).
 *
 * This reuses the full send layer (lib/channels.sendTouch), so ONE call:
 *   1. routes through the owned MTA when SENDING_EMAIL_PROVIDER=mta — picking a
 *      warmed mailbox (caps / rotation / warm-up) and honoring suppression,
 *   2. logs a person_event to the ATS,
 *   3. fires the reactive email-sent -> voice-drop trigger (opt-in via
 *      RECRUITEROS_VOICE_ON_SEND); the /api/voice/cron tick then drains the drop
 *      inside the lead's own calling window with every gate already enforced.
 *
 * Requires an active Postal server + SENDING_EMAIL_PROVIDER=mta for the owned
 * path; otherwise the send layer falls back to whatever email provider is wired.
 */

import { NextResponse } from "next/server";
import { sendTouch } from "../../../../lib/channels";
import { requireAuth } from "../../../../lib/linkedin/auth";
import type { Prospect } from "../../../../lib/core/types";

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if (!auth.ok) return auth.response;

  let body: {
    workspaceId?: string;
    prospect?: Prospect;
    subject?: string;
    html?: string;
    text?: string;
    voiceCampaignId?: string;
    /** Self-learning attribution: the rich variant id (`family::methodology`),
     *  campaign, and touch the queue assigned — must round-trip so logTouch can
     *  stamp the activity and the optimizer can measure this methodology. */
    variant?: string;
    campaignId?: string;
    touch?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { workspaceId, prospect, subject } = body;
  const htmlBody = body.html ?? body.text;
  if (!workspaceId || !prospect?.email || !subject || !htmlBody) {
    return NextResponse.json(
      {
        error: "missing_fields",
        detail: "workspaceId, prospect.email, subject and html are required",
      },
      { status: 422 },
    );
  }

  const result = await sendTouch(workspaceId, {
    channel: "email",
    prospect,
    subject,
    text: htmlBody,
    voiceCampaignId: body.voiceCampaignId,
    variant: body.variant,
    campaignId: body.campaignId,
    touch: body.touch,
  });

  return NextResponse.json(
    {
      ok: result.ok,
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      dryRun: result.dryRun,
      error: result.error,
    },
    { status: result.ok ? 200 : 502 },
  );
}
