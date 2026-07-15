/**
 * POST /api/linkedin/webhook
 * Provider webhook ingest (Unipile). Two consumers:
 *   1. The LinkedIn OS shared engine (lib/linkedin/os/events): raw event
 *      stored, normalized to domain events, then reply stop, inbox, accept
 *      gates and account health all run. Requires a workspace: configure the
 *      Unipile webhook URL as .../api/linkedin/webhook?ws=<workspaceId>.
 *   2. The legacy in-memory sequence engine (accept-triggered follow-ups for
 *      the old nav-less automation view), kept for back-compat.
 */

import { NextResponse } from "next/server";
import { SequenceEngine } from "../../../../lib/linkedin/sequenceEngine";
import { getRepository } from "../../../../lib/linkedin/repository";
import { verifyProviderSignature } from "../../../../lib/linkedin/auth";
import { ingestProviderWebhook, storeRawEvent } from "../../../../lib/linkedin/os/events";
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

  // LinkedIn OS ingestion (workspace-scoped). Without ws we still keep the
  // raw event for debugging, but domain consumers need the workspace.
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("ws") ?? req.headers.get("x-workspace-id") ?? "";
  let osEvents = 0;
  try {
    if (workspaceId) {
      osEvents = (await ingestProviderWebhook(workspaceId, payload)).events;
    } else {
      await storeRawEvent("unipile", payload);
    }
  } catch { /* OS ingestion must never break the legacy path */ }

  const event = normalizeUnipileEvent(payload);
  if (!event) return NextResponse.json({ ok: true, osEvents, ignored: true });

  const engine = new SequenceEngine(getRepository());
  await engine.handleEvent(event);
  return NextResponse.json({ ok: true, osEvents });
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
