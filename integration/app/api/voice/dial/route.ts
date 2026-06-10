/**
 * POST /api/voice/dial
 * Place an outbound call through the Telnyx dialer with Premium answering-machine
 * detection.
 *
 * Body: { to, from?, workspaceId?, motion?, ref? }
 * The call is fired with AMD on; the per-call decision (human -> warm transfer,
 * machine -> voicemail drop) is made later by /api/voice/webhook as Telnyx posts
 * call-control events. `workspaceId`/`motion`/`ref` ride along in client_state so
 * the webhook can bill the minutes and correlate the call with zero state here.
 *
 * Used by RecruiterOS for the BD/recruiting voice dialer and by the cadence's
 * voice channel. Mirrors /api/sms/send.
 */

import { NextResponse } from "next/server";
import { telnyx } from "../../../../lib/providers";
import { withWorkspaceCreds } from "../../../../lib/connected";
import { requireAuth } from "../../../../lib/linkedin/auth";

function appUrl(): string {
  return process.env.RECRUITEROS_APP_URL ?? "https://app.recruitersos.co";
}

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if (!auth.ok) return auth.response;

  let body: { to?: string; from?: string; workspaceId?: string; motion?: string; ref?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.to) {
    return NextResponse.json(
      { error: "missing_fields", detail: "to is required" },
      { status: 422 },
    );
  }

  const connectionId = process.env.TELNYX_CONNECTION_ID ?? "";
  if (!connectionId && telnyx.configured()) {
    return NextResponse.json(
      { error: "not_configured", detail: "TELNYX_CONNECTION_ID is required to place calls" },
      { status: 422 },
    );
  }

  const clientState: Record<string, unknown> = {};
  if (body.workspaceId) clientState.workspaceId = body.workspaceId;
  if (body.motion) clientState.motion = body.motion;
  if (body.ref !== undefined) clientState.ref = body.ref;

  // Isolation: a customer's dial uses their own Telnyx, never the operator's env.
  // No workspaceId (raw house/engine call) -> unisolated, unchanged behaviour.
  const dial = () =>
    telnyx.dialWithAmd(
      body.to!,
      connectionId,
      `${appUrl()}/api/voice/webhook`,
      Object.keys(clientState).length ? clientState : undefined,
    );
  const result: any = body.workspaceId
    ? await withWorkspaceCreds(body.workspaceId, dial)
    : await dial();

  // dryRun (no TELNYX_API_KEY) still returns ok:true so the engine runs end to end.
  return NextResponse.json(
    {
      ok: true,
      dryRun: Boolean(result?.dryRun),
      callControlId: result?.data?.call_control_id,
    },
    { status: 200 },
  );
}
