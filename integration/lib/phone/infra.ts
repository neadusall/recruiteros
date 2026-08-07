/**
 * RecruitersOS · Phone · Telnyx provisioning
 *
 * Idempotent, per-workspace setup for the browser phone (mirrors the AI
 * Vetting provisionDesk seam): a Call Control application for the PSTN legs
 * plus a Credential Connection for the browsers, and one telephony credential
 * per user. Everything is create-or-adopt: reruns reconcile instead of
 * duplicating, and every Telnyx call runs inside the caller's workspace
 * credential context (callers wrap in withWorkspaceCreds).
 */

import { randomBytes } from "crypto";
import { telnyx } from "../providers";
import { getInfra, patchInfra, getUserState, patchUserState } from "./store";
import { nowIso } from "../core/ids";
import type { PhoneInfra } from "./types";

const APP_NAME = "RecruitersOS Phone";
const CRED_CONN_NAME = "RecruitersOS Phone WebRTC";
/**
 * Every browser leg in this system is dialed to `sip:<credential>@sip.telnyx.com`
 * (see sipUriFor). Telnyx creates credential connections with SIP URI calling
 * DISABLED, and then refuses those legs outright: the call dies in about a
 * second with no ring, no answer, and a hangup cause that reads like the far
 * end was busy. "internal" accepts only calls originated by connections on the
 * same Telnyx account, which is exactly our own Call Control application.
 */
const SIP_URI_CALLING = "internal";

function appUrl(): string {
  return process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co";
}

export function phoneWebhookUrl(): string {
  return `${appUrl()}/api/phone/webhook`;
}

/**
 * Ensure the workspace's Call Control app + Credential Connection exist.
 * Safe to call on every admin page load; only hits Telnyx when something is
 * missing. Throws with a readable message when Telnyx rejects (surfaced in
 * the setup panel), and records lastError either way.
 */
export async function ensureInfra(workspaceId: string): Promise<PhoneInfra> {
  const infra = getInfra(workspaceId);
  if (infra.appId && infra.credentialConnectionId) {
    // Provisioned, but workspaces set up before this reconcile exists carry a
    // credential connection that silently refuses every browser leg. One PATCH,
    // once, on the next connect — it is what makes an existing phone start
    // working without anyone having to touch the Telnyx portal.
    if (infra.sipUriCalling !== SIP_URI_CALLING) {
      await ensureSipUriCalling(workspaceId, infra.credentialConnectionId);
      return getInfra(workspaceId);
    }
    return infra;
  }

  try {
    if (!infra.appId) {
      const appId = await findOrCreateApp();
      patchInfra(workspaceId, { appId, webhookUrl: phoneWebhookUrl() });
    }
    if (!infra.credentialConnectionId) {
      const credentialConnectionId = await findOrCreateCredentialConnection();
      patchInfra(workspaceId, { credentialConnectionId });
    }
    const connId = getInfra(workspaceId).credentialConnectionId;
    if (connId) await ensureSipUriCalling(workspaceId, connId);
    return patchInfra(workspaceId, { provisionedAt: nowIso(), lastError: undefined });
  } catch (e: any) {
    patchInfra(workspaceId, { lastError: String(e?.message ?? e) });
    throw e;
  }
}

/**
 * Let this account's own connections dial the browsers' SIP URIs. Idempotent,
 * and deliberately verified from the response rather than assumed: the marker
 * is only written when Telnyx echoes the value back, so a rejected PATCH is
 * retried on the next connect instead of being remembered as done. Never
 * throws — a phone that is otherwise fine must not fail to hand out a token.
 */
async function ensureSipUriCalling(workspaceId: string, connectionId: string): Promise<void> {
  try {
    const res = await telnyx.updateCredentialConnection(connectionId, {
      sip_uri_calling_preference: SIP_URI_CALLING,
    });
    if (res?.dryRun) return;
    const applied = String(res?.data?.sip_uri_calling_preference ?? "");
    if (applied === SIP_URI_CALLING || applied === "unrestricted") {
      patchInfra(workspaceId, { sipUriCalling: applied, lastError: undefined });
      return;
    }
    patchInfra(workspaceId, {
      lastError: "telnyx_provision: Telnyx did not accept SIP URI calling on the browser connection, so browser calls will not connect",
    });
  } catch (e: any) {
    patchInfra(workspaceId, { lastError: `telnyx_provision: ${String(e?.message ?? e)}`.slice(0, 300) });
  }
}

/** Adopt an existing app by name (reruns, restored snapshots) or create one. */
async function findOrCreateApp(): Promise<string> {
  const list = await telnyx.listCallControlApps();
  if (!list?.dryRun) {
    const existing = (list?.data ?? []).find(
      (a: any) => a?.application_name === APP_NAME,
    );
    if (existing?.id) {
      // Reconcile the webhook target in case the deployment URL changed.
      const url = phoneWebhookUrl();
      if (existing.webhook_event_url !== url) {
        await telnyx.updateCallControlApp(String(existing.id), {
          webhook_event_url: url,
          webhook_api_version: "2",
        }).catch(() => {});
      }
      return String(existing.id);
    }
  }
  const created = await telnyx.createCallControlApp(APP_NAME, phoneWebhookUrl());
  const id = created?.data?.id;
  if (!id) throw new Error("telnyx_provision: could not create the call control application");
  await attachOutboundProfile(String(id));
  return String(id);
}

/** Resolve the account's outbound voice profile, adopting the first that
 *  exists or creating one. Both the Call Control app AND the WebRTC credential
 *  connection must carry it to place PSTN calls (Telnyx rejects the leg
 *  otherwise). Best-effort. */
async function ensureOutboundProfileId(): Promise<string | undefined> {
  const profiles = await telnyx.listOutboundVoiceProfiles();
  let profileId = profiles?.data?.[0]?.id;
  if (!profileId) {
    const created = await telnyx.createOutboundVoiceProfile(APP_NAME);
    profileId = created?.data?.id;
  }
  return profileId ? String(profileId) : undefined;
}

async function attachOutboundProfile(appId: string): Promise<void> {
  try {
    const profileId = await ensureOutboundProfileId();
    if (profileId) {
      await telnyx.updateCallControlApp(appId, {
        outbound: { outbound_voice_profile_id: profileId },
      });
    }
  } catch {
    // Leave unattached; outbound dialing will surface a clear Telnyx error
    // and the setup panel shows the remedy. Inbound still works.
  }
}

/** The WebRTC credential connection also needs an outbound voice profile:
 *  browser legs dial PSTN through the credential connection, and Telnyx
 *  rejects the call outright without one. Mirrors attachOutboundProfile. */
async function attachConnectionOutboundProfile(connectionId: string): Promise<void> {
  try {
    const profileId = await ensureOutboundProfileId();
    if (profileId) {
      await telnyx.updateCredentialConnection(connectionId, {
        outbound: { outbound_voice_profile_id: profileId },
      });
    }
  } catch {
    // Leave unattached; browser dialing surfaces a clear Telnyx error.
  }
}

async function findOrCreateCredentialConnection(): Promise<string> {
  const list = await telnyx.listCredentialConnections();
  if (!list?.dryRun) {
    const existing = (list?.data ?? []).find(
      (c: any) => c?.connection_name === CRED_CONN_NAME,
    );
    if (existing?.id) {
      // Reconcile: connections created before this fix carry no outbound voice
      // profile, so browser PSTN calls are rejected. Attach one if missing
      // (idempotent: a redundant PATCH when already set is harmless).
      if (!existing?.outbound?.outbound_voice_profile_id) {
        await attachConnectionOutboundProfile(String(existing.id));
      }
      return String(existing.id);
    }
  }
  // Connection-level SIP username must be globally unique on Telnyx.
  const userName = `roswebrtc${randomBytes(6).toString("hex")}`;
  const password = randomBytes(18).toString("base64url");
  const created = await telnyx.createCredentialConnection(CRED_CONN_NAME, userName, password);
  const id = created?.data?.id;
  if (!id) throw new Error("telnyx_provision: could not create the credential connection");
  await attachConnectionOutboundProfile(String(id));
  return String(id);
}

/**
 * Ensure the user has a WebRTC telephony credential, and return a fresh
 * login token for the browser. Credentials are minted once per user and
 * reused; tokens are short-lived and minted on every connect.
 */
export async function issueUserToken(
  workspaceId: string, userId: string, userName?: string,
): Promise<{ token: string; sipUsername: string }> {
  const infra = await ensureInfra(workspaceId);
  if (!infra.credentialConnectionId) {
    throw Object.assign(new Error("phone_not_provisioned"), { status: 409 });
  }
  const state = getUserState(workspaceId, userId);

  let credentialId = state.credentialId;
  let sipUsername = state.sipUsername ?? "";

  if (credentialId) {
    // Verify the credential still exists and is not expired; re-mint if gone.
    try {
      const cur = await telnyx.getTelephonyCredential(credentialId);
      if (cur?.dryRun) return { token: "", sipUsername };
      if (cur?.data?.expired) credentialId = undefined;
      else sipUsername = String(cur?.data?.sip_username ?? sipUsername);
    } catch {
      credentialId = undefined;
    }
  }

  if (!credentialId) {
    const created = await telnyx.createTelephonyCredential(
      infra.credentialConnectionId,
      `ros-phone ${userName || userId}`.slice(0, 60),
    );
    if (created?.dryRun) return { token: "", sipUsername: "" };
    credentialId = created?.data?.id ? String(created.data.id) : undefined;
    sipUsername = String(created?.data?.sip_username ?? "");
    if (!credentialId || !sipUsername) {
      throw new Error("telnyx_provision: could not create the user's calling credential");
    }
    patchUserState(workspaceId, userId, { credentialId, sipUsername });
  }

  const token = await telnyx.credentialToken(credentialId);
  if (!token) throw new Error("telnyx_provision: could not mint a calling token");
  return { token, sipUsername };
}

/** SIP URI a browser leg is dialed to for a given user's registration. */
export function sipUriFor(sipUsername: string): string {
  return `sip:${sipUsername}@sip.telnyx.com`;
}
