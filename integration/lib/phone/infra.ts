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
import { phoneAlert } from "./alerts";
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
/** How long a proven-good SIP URI setting is trusted before it is re-checked. */
const SIP_URI_RECHECK_MS = 6 * 60 * 60 * 1000;

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
    // Provisioned, but this is the setting the whole phone hangs on, so it is
    // re-checked rather than remembered: a workspace set up before the fix
    // existed heals on the next connect, and one changed in the Telnyx portal
    // afterwards is caught within a few hours instead of after a few weeks of
    // calls that quietly refuse to ring.
    if (infra.sipUriCalling !== SIP_URI_CALLING || checkDue(infra.sipUriCallingAt)) {
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

/** True when the SIP URI setting has not been proven against Telnyx recently. */
function checkDue(at?: string): boolean {
  const t = at ? Date.parse(at) : NaN;
  return !Number.isFinite(t) || Date.now() - t > SIP_URI_RECHECK_MS;
}

/**
 * Prove — and if need be restore — the one Telnyx setting every browser call
 * depends on. Read first, so drift can be told apart from first-time setup:
 * a connection that was working and is now "disabled" means someone changed it
 * out from under the product, and that is worth saying out loud rather than
 * quietly repairing. The marker is written only when Telnyx echoes the value
 * back, so a rejected write is retried instead of remembered as done. Never
 * throws: a phone that is otherwise fine must still get its token.
 */
async function ensureSipUriCalling(workspaceId: string, connectionId: string): Promise<void> {
  const before = getInfra(workspaceId).sipUriCalling;
  try {
    const cur = await telnyx.getCredentialConnection(connectionId).catch(() => null);
    const live = String((cur as any)?.data?.sip_uri_calling_preference ?? "");
    if (live && live !== "disabled") {
      patchInfra(workspaceId, { sipUriCalling: live, sipUriCallingAt: nowIso(), lastError: undefined });
      return;
    }

    const res = await telnyx.updateCredentialConnection(connectionId, {
      sip_uri_calling_preference: SIP_URI_CALLING,
    });
    if (res?.dryRun) return;
    const applied = String(res?.data?.sip_uri_calling_preference ?? "");
    if (applied && applied !== "disabled") {
      patchInfra(workspaceId, { sipUriCalling: applied, sipUriCallingAt: nowIso(), lastError: undefined });
      // Repairing a setting that was already proven good means it was changed
      // elsewhere. Calls were failing until this moment, so the owner hears it.
      if (before && before !== "disabled") {
        void phoneAlert(workspaceId, "PHONE-SIP-URI-CALLING-DISABLED",
          "Browser calling was switched off on this workspace's Telnyx connection and has been switched back on.",
          `SIP URI calling on connection ${connectionId} was found "disabled" and was reset to "${applied}". While it was off, every browser call failed within a second without ringing. If someone changed it in the Telnyx portal, leave it on ${SIP_URI_CALLING}.`);
      }
      return;
    }
    patchInfra(workspaceId, {
      sipUriCallingAt: nowIso(),
      lastError: "telnyx_provision: Telnyx did not accept SIP URI calling on the browser connection, so browser calls will not connect",
    });
    void phoneAlert(workspaceId, "PHONE-SIP-URI-CALLING-REFUSED",
      "Browser calling could not be enabled on this workspace's Telnyx connection.",
      `Telnyx would not set sip_uri_calling_preference on connection ${connectionId}. Until it is set to "${SIP_URI_CALLING}" (Voice, SIP Trunking, Authentication and routing), every browser call will fail within a second without ringing.`);
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
