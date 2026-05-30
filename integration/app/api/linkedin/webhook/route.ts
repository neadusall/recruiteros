/**
 * POST /api/linkedin/webhook
 * Provider webhook ingest (Unipile). Normalizes raw events and feeds them to
 * the sequence engine for accept-triggered follow-ups and pause-on-reply.
 *
 * Configure this URL in the Unipile dashboard for messaging + relations events.
 */

import { NextResponse } from "next/server";
import { SequenceEngine } from "../../../../lib/linkedin/sequenceEngine";
import { getRepository } from "../../../../lib/linkedin/repository";
import { verifyProviderSignature } from "../../../../lib/linkedin/auth";
import type { LinkedInWebhookEvent } from "../../../../lib/linkedin/types";

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyProviderSignature(req, raw)) {
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const event = normalizeUnipileEvent(payload);
  if (!event) return NextResponse.json({ ok: true, ignored: true });

  const engine = new SequenceEngine(getRepository());
  await engine.handleEvent(event);
  return NextResponse.json({ ok: true });
}

/** Map a raw Unipile webhook into our normalized event shape. */
function normalizeUnipileEvent(p: Record<string, any>): LinkedInWebhookEvent | null {
  const accountId = String(p.account_id ?? p.account?.id ?? "");
  const at = String(p.timestamp ?? new Date().toISOString());

  switch (p.event ?? p.type) {
    case "new_relation":
    case "invitation_accepted":
      return { type: "invite_accepted", accountId, providerProfileId: String(p.user_provider_id ?? p.from), at };
    case "message_received":
    case "new_message":
      if (p.is_sender || p.from_self) {
        return { type: "message_sent", accountId, providerMessageId: String(p.message_id ?? p.id), at };
      }
      return {
        type: "message_received",
        accountId,
        providerProfileId: String(p.sender_provider_id ?? p.from),
        text: String(p.text ?? p.message ?? ""),
        providerMessageId: String(p.message_id ?? p.id),
        at,
      };
    case "account_status":
      return { type: "account_status", accountId, status: mapStatus(String(p.status)), at };
    default:
      return null;
  }
}

function mapStatus(s: string): "ok" | "warming" | "restricted" | "disconnected" {
  const map: Record<string, "ok" | "warming" | "restricted" | "disconnected"> = {
    OK: "ok", CONNECTING: "warming", ERROR: "restricted", CREDENTIALS: "disconnected",
  };
  return map[s] ?? "ok";
}
