/**
 * RecruiterOS · Providers · Unipile (LinkedIn channel)
 * Base: https://{UNIPILE_DSN}  ·  Auth: X-API-KEY.
 * Used for: sending connection invites, 1:1 DMs, and voice notes; reading
 * account status for the health sweep. Webhooks are ingested separately.
 */

import { ProviderClient } from "./http";

export class UnipileClient extends ProviderClient {
  id = "unipile";
  label = "Unipile (LinkedIn)";
  protected envKeys = ["UNIPILE_API_KEY", "UNIPILE_DSN"];
  protected get baseUrl() {
    const dsn = this.env("UNIPILE_DSN");
    return dsn.startsWith("http") ? dsn : `https://${dsn}`;
  }

  protected authHeaders() {
    return { "X-API-KEY": this.env("UNIPILE_API_KEY"), accept: "application/json" };
  }

  async verify() {
    try {
      await this.request({ path: "/api/v1/accounts", query: { limit: 1 } });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

  listAccounts() {
    return this.request({ path: "/api/v1/accounts" });
  }

  /** Send a connection invitation (optionally with a note). */
  sendInvite(accountId: string, providerProfileId: string, message?: string) {
    return this.request({
      method: "POST",
      path: "/api/v1/users/invite",
      body: { account_id: accountId, provider_id: providerProfileId, message },
    });
  }

  /** Send a 1:1 message to a connection. */
  sendMessage(accountId: string, providerProfileId: string, text: string) {
    return this.request({
      method: "POST",
      path: "/api/v1/chats/messages",
      body: { account_id: accountId, attendees_ids: [providerProfileId], text },
    });
  }

  /** Send an audio/voice note. */
  sendVoiceNote(accountId: string, providerProfileId: string, audioUrl: string) {
    return this.request({
      method: "POST",
      path: "/api/v1/chats/messages",
      body: { account_id: accountId, attendees_ids: [providerProfileId], voice_message: audioUrl },
    });
  }
}
