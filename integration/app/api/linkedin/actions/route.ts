/**
 * POST /api/linkedin/actions
 * Execute a single LinkedIn action immediately (outside a sequence).
 *
 * Use this for one-off sends from RecruiterOS, manual recruiter actions, or
 * testing. The same account-safety gate applies.
 *
 * Body: { accountId, prospect, action, text?, subject?, audio? }
 * action ∈ connect | message | inmail | voice_note | profile_view | endorse | withdraw_invite
 */

import { NextResponse } from "next/server";
import { getProvider } from "../../../../lib/linkedin/provider";
import { getRepository } from "../../../../lib/linkedin/repository";
import { gate } from "../../../../lib/linkedin/rateLimiter";
import { requireAuth } from "../../../../lib/linkedin/auth";
import type { LinkedInActionType, Prospect } from "../../../../lib/linkedin/types";

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if (!auth.ok) return auth.response;

  let body: {
    accountId?: string;
    prospect?: Prospect;
    action?: LinkedInActionType;
    text?: string;
    subject?: string;
    audio?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { accountId, prospect, action } = body;
  if (!accountId || !prospect?.providerProfileId || !action) {
    return NextResponse.json(
      { error: "missing_fields", detail: "accountId, prospect.providerProfileId and action are required" },
      { status: 422 },
    );
  }

  const repo = getRepository();
  const account = await repo.getAccount(accountId);
  if (!account) return NextResponse.json({ error: "account_not_found" }, { status: 404 });

  const g = await gate(account, action);
  if (!g.allowed) {
    return NextResponse.json(
      { error: "rate_limited", reason: g.reason, retryAt: g.retryAt },
      { status: 429 },
    );
  }

  const provider = getProvider();
  let result;
  switch (action) {
    case "connect":
      result = await provider.sendConnection({ account, prospect, note: body.text });
      break;
    case "message":
      result = await provider.sendMessage({ account, prospect, text: body.text ?? "" });
      break;
    case "inmail":
      result = await provider.sendInMail({
        account, prospect, text: body.text ?? "", subject: body.subject ?? `Quick note, ${prospect.firstName}`,
      });
      break;
    case "voice_note":
      result = await provider.sendVoiceNote({ account, prospect, audio: body.audio ?? "" });
      break;
    case "profile_view":
      result = await provider.viewProfile(account, prospect.providerProfileId);
      break;
    case "endorse":
      result = await provider.endorseTopSkills(account, prospect.providerProfileId);
      break;
    case "withdraw_invite":
      result = await provider.withdrawInvite(account, prospect.providerProfileId);
      break;
    default:
      return NextResponse.json({ error: "unknown_action" }, { status: 422 });
  }

  return NextResponse.json({ result }, { status: result.ok ? 200 : 502 });
}
