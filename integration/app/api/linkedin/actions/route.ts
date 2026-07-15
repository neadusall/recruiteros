/**
 * POST /api/linkedin/actions
 * Execute a single LinkedIn action (outside a sequence), server-to-server.
 *
 * Since the LinkedIn OS build, this is a thin shim over the SHARED LinkedIn
 * engine: the request becomes a ledger-tracked action request with the same
 * policy, utilization, reservation and pacing checks as every other LinkedIn
 * action in RecruitersOS. Nothing here talks to the provider directly.
 *
 * Body: { workspaceId, accountId, prospect | person, action, text?, subject?, audio? }
 * action ∈ connect | message | inmail | voice_note | profile_view | endorse | withdraw_invite
 */

import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/linkedin/auth";
import { requestLinkedInAction } from "../../../../lib/linkedin/os/engine";
import type { LiActionType } from "../../../../lib/linkedin/os/types";

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if (!auth.ok) return auth.response;

  let body: {
    workspaceId?: string;
    accountId?: string;
    prospect?: {
      providerProfileId?: string;
      publicProfileUrl?: string;
      fullName?: string;
      firstName?: string;
      company?: string;
    };
    action?: string;
    text?: string;
    subject?: string;
    audio?: string;
    businessUnit?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { workspaceId, accountId, prospect, action } = body;
  if (!workspaceId || !accountId || !prospect || !action) {
    return NextResponse.json(
      { error: "missing_fields", detail: "workspaceId, accountId, prospect and action are required" },
      { status: 422 },
    );
  }
  const map: Record<string, LiActionType> = {
    connect: "connect", connect_note: "connect_note", message: "message",
    inmail: "inmail", voice_note: "voice_note", profile_view: "profile_view",
    endorse: "endorse", withdraw_invite: "withdraw_invite",
  };
  const actionType = map[action];
  if (!actionType) return NextResponse.json({ error: "unknown_action" }, { status: 422 });

  const res = await requestLinkedInAction({
    workspaceId,
    accountId,
    person: {
      linkedinUrl: prospect.publicProfileUrl,
      providerProfileId: prospect.providerProfileId,
      fullName: prospect.fullName,
      company: prospect.company,
    },
    actionType,
    payload: {
      text: body.text,
      note: actionType === "connect" || actionType === "connect_note" ? body.text : undefined,
      subject: body.subject,
      audioUrl: body.audio,
      providerProfileId: prospect.providerProfileId,
      linkedinUrl: prospect.publicProfileUrl,
    },
    businessUnit: body.businessUnit === "recruiting" ? "recruiting" : "bd",
    sourceType: "manual",
    priority: "high",
  });

  return NextResponse.json(
    {
      result: {
        ok: res.accepted,
        action: actionType,
        actionId: res.record.id,
        status: res.record.status,
        scheduledAt: res.record.scheduledAt,
        reason: res.reason,
      },
    },
    { status: res.accepted ? 200 : 429 },
  );
}
