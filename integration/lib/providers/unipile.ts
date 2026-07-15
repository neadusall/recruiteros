/**
 * RecruitersOS · Providers · Unipile (LinkedIn channel)
 * Base: https://{UNIPILE_DSN}  ·  Auth: X-API-KEY.
 * Used for: sending connection invites, 1:1 DMs, and voice notes; reading
 * account status for the health sweep. Webhooks are ingested separately.
 */

import { ProviderClient } from "./http";

export class UnipileClient extends ProviderClient {
  id = "unipile";
  label = "Unipile (LinkedIn)";
  // Only the API key is a required secret; the DSN (this account's regional host)
  // defaults to the configured instance and can be overridden by UNIPILE_DSN.
  protected envKeys = ["UNIPILE_API_KEY"];
  protected get baseUrl() {
    const dsn = process.env.UNIPILE_DSN || "api48.unipile.com:17846";
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

  /** Recent posts authored by a member — used to pick a target for a nurture comment.
   *  NOTE: confirm the exact path/shape against the current Unipile API; mirrors the
   *  client's /api/v1/users/{identifier}/... convention. */
  listPosts(accountId: string, providerProfileId: string, limit = 5) {
    return this.request({
      path: `/api/v1/users/${encodeURIComponent(providerProfileId)}/posts`,
      query: { account_id: accountId, limit },
    });
  }

  /** Leave a comment on a post (the nurture "comment on their post" touch).
   *  NOTE: confirm the exact path/shape against the current Unipile API. */
  commentOnPost(accountId: string, postId: string, text: string) {
    return this.request({
      method: "POST",
      path: `/api/v1/posts/${encodeURIComponent(postId)}/comments`,
      body: { account_id: accountId, text },
    });
  }

  /** React to a post (the LinkedIn OS "like post" touch).
   *  NOTE: confirm the exact path/shape against the current Unipile API. */
  likePost(accountId: string, postId: string, reaction = "like") {
    return this.request({
      method: "POST",
      path: `/api/v1/posts/${encodeURIComponent(postId)}/reaction`,
      body: { account_id: accountId, reaction_type: reaction },
    });
  }
}
