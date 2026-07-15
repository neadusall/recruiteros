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

  /**
   * Publish a feed post as the linked account (the LinkedIn Poster publish hop).
   * Text-only goes as JSON; with images we send multipart form-data, which is
   * how Unipile accepts post attachments. Returns the provider's post reference
   * when it gives one.
   */
  async createPost(
    accountId: string,
    text: string,
    attachments?: Array<{ bytes: Buffer; mime: string; name: string }>,
  ): Promise<{ id?: string; dryRun?: boolean }> {
    if (!attachments?.length) {
      const r = await this.request<{ post_id?: string; id?: string }>({
        method: "POST",
        path: "/api/v1/posts",
        body: { account_id: accountId, text },
      });
      return { id: r.post_id ?? r.id, dryRun: r.dryRun };
    }
    // Multipart path: ProviderClient.request is JSON-only, so build the form here.
    if (!this.configured()) {
      console.info(`[${this.id}:dry] POST /api/v1/posts (multipart, ${attachments.length} attachment(s))`);
      return { dryRun: true };
    }
    const form = new FormData();
    form.append("account_id", accountId);
    form.append("text", text);
    for (const a of attachments) {
      form.append("attachments", new Blob([new Uint8Array(a.bytes)], { type: a.mime }), a.name);
    }
    const base = (this.baseUrl || "").replace(/\/$/, "");
    const res = await fetch(`${base}/api/v1/posts`, {
      method: "POST",
      headers: this.authHeaders(), // no Content-Type: fetch sets the multipart boundary
      body: form,
    });
    const textBody = await res.text();
    let data: any = {};
    try { data = JSON.parse(textBody); } catch { data = { raw: textBody }; }
    if (!res.ok) {
      const detail = data?.detail?.message || data?.detail || data?.message || data?.error || "";
      throw Object.assign(new Error(detail ? `unipile_${res.status}: ${detail}` : `unipile_${res.status}`), { status: res.status });
    }
    return { id: data.post_id ?? data.id };
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
