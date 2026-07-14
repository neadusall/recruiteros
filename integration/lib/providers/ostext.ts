/**
 * RecruitersOS · Providers · OS Text (SMS channel, post-engagement)
 * Base: TALTXT_API_URL · Auth: Bearer.
 * Used for: sending the post-engagement SMS, and opt-out (DNC mirror). Inbound
 * replies + classification arrive via the OS Text webhook (ingested separately).
 *
 * NOTE: distinct from the user's own lib/sms/ module; this is the GTM-OS SMS
 * connector named in the reference. Underlying transport is Telnyx 10DLC.
 * The wire id "taltxt" and TALTXT_* env keys are legacy identifiers kept for
 * compatibility with existing DB rows, server env, and webhook routes.
 */

import { ProviderClient } from "./http";

export class OsTextClient extends ProviderClient {
  id = "taltxt";
  label = "OS Text (SMS)";
  protected envKeys = ["TALTXT_API_KEY", "TALTXT_API_URL"];
  protected get baseUrl() {
    return this.env("TALTXT_API_URL") || "https://api.taltxt.io";
  }

  protected authHeaders() {
    return { Authorization: `Bearer ${this.env("TALTXT_API_KEY")}` };
  }

  async verify() {
    try {
      await this.request({ path: "/health" });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

  /** Send a post-engagement SMS within a campaign. */
  sendSms(campaignId: string, to: string, body: string) {
    return this.request({ method: "POST", path: "/messages", body: { campaign_id: campaignId, to, body } });
  }

  /** Approve + send a Claude-drafted reply. */
  sendReply(conversationId: string, body: string) {
    return this.request({ method: "POST", path: `/conversations/${conversationId}/reply`, body: { body } });
  }

  /** DNC mirror: opt a contact out (also enforced by Telnyx STOP at 10DLC). */
  optOut(phone: string) {
    return this.request({ method: "POST", path: "/contacts/opt-out", body: { phone } });
  }
}
