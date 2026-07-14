/**
 * RecruitersOS · Response
 * Webhook normalizers: turn each provider's raw reply payload into one
 * `InboundResponse`, then match it to a prospect.
 *
 * Sources (from the reference): Instantly.ai (email), SalesRobot/Unipile
 * (LinkedIn DMs), OS Text (SMS). Each is a separate webhook with its own shape.
 */

import { getCore } from "../core/repository";
import { rid, nowIso } from "../core/ids";
import type { Channel } from "../core/types";
import type { InboundResponse, ResponseSource } from "./types";

type Raw = Record<string, any>;

/** Build the normalized inbound (prospect match resolved separately). */
function base(
  workspaceId: string,
  source: ResponseSource,
  channel: Channel,
  fields: Partial<InboundResponse>,
): InboundResponse {
  return {
    id: rid("resp"),
    workspaceId,
    prospectId: null,
    channel,
    source,
    providerMessageId: fields.providerMessageId ?? rid("msg"),
    fromName: fields.fromName,
    fromHandle: fields.fromHandle,
    text: fields.text ?? "",
    receivedAt: fields.receivedAt ?? nowIso(),
    campaignId: fields.campaignId,
  };
}

export function fromInstantly(workspaceId: string, p: Raw): InboundResponse | null {
  // campaign.replied event
  const evt = String(p.event_type ?? p.event ?? "");
  if (evt && !/repl/i.test(evt)) return null;
  return base(workspaceId, "instantly", "email", {
    providerMessageId: String(p.message_id ?? p.id ?? p.reply_id ?? ""),
    fromName: p.lead_name ?? p.firstName,
    fromHandle: String(p.lead_email ?? p.email ?? "").toLowerCase(),
    text: String(p.reply_text ?? p.reply ?? p.text ?? p.body ?? ""),
    receivedAt: p.timestamp ?? p.created_at,
    campaignId: p.campaign_id,
  });
}

export function fromUnipile(workspaceId: string, p: Raw): InboundResponse | null {
  const evt = p.event ?? p.type;
  if (p.is_sender || p.from_self) return null;        // outbound echo
  if (evt && !/message_received|new_message|message-received/i.test(String(evt))) return null;
  return base(workspaceId, p.provider === "salesrobot" ? "salesrobot" : "unipile", "linkedin", {
    providerMessageId: String(p.message_id ?? p.id ?? ""),
    fromName: p.sender_name ?? p.from_name,
    fromHandle: String(p.sender_profile_url ?? p.profileUrl ?? p.sender_provider_id ?? p.from ?? ""),
    text: String(p.text ?? p.message ?? ""),
    receivedAt: p.timestamp,
  });
}

export function fromOsText(workspaceId: string, p: Raw): InboundResponse | null {
  const evt = String(p.event ?? p.type ?? "");
  if (evt && !/message[._-]?received|inbound|reply/i.test(evt)) return null;
  return base(workspaceId, "taltxt", "sms", {
    providerMessageId: String(p.message_id ?? p.id ?? ""),
    fromName: p.contact_name,
    fromHandle: String(p.from ?? p.phone ?? p.contact_phone ?? ""),
    text: String(p.text ?? p.body ?? p.message ?? ""),
    receivedAt: p.received_at ?? p.timestamp,
    campaignId: p.campaign_id,
  });
}

const NORMALIZERS: Record<ResponseSource, (ws: string, p: Raw) => InboundResponse | null> = {
  instantly: fromInstantly,
  unipile: fromUnipile,
  salesrobot: fromUnipile,
  taltxt: fromOsText,
};

export function normalize(source: ResponseSource, workspaceId: string, payload: Raw): InboundResponse | null {
  const fn = NORMALIZERS[source];
  return fn ? fn(workspaceId, payload) : null;
}

/** Resolve the inbound to a known prospect by its channel handle. */
export async function matchProspect(inbound: InboundResponse): Promise<InboundResponse> {
  const core = getCore();
  const h = inbound.fromHandle;
  if (!h) return inbound;
  let p =
    inbound.channel === "email"
      ? await core.findProspectByEmail(inbound.workspaceId, h)
      : inbound.channel === "linkedin"
        ? await core.findProspectByLinkedin(inbound.workspaceId, h)
        : await core.findProspectByPhone(inbound.workspaceId, h);
  if (p) {
    inbound.prospectId = p.id;
    inbound.campaignId = inbound.campaignId ?? p.campaignId;
  }
  return inbound;
}
