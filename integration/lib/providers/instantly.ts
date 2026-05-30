/**
 * RecruiterOS · Providers · Instantly.ai (email channel)
 * Base: https://api.instantly.ai/api/v2 · Auth: Bearer.
 * Used for: pushing leads into a campaign, pausing on reply, domain vitals
 * (health sweep), and the block-list (DNC mirror).
 */

import { ProviderClient } from "./http";

export class InstantlyClient extends ProviderClient {
  id = "instantly";
  label = "Instantly (email)";
  protected envKeys = ["INSTANTLY_API_KEY"];
  protected baseUrl = "https://api.instantly.ai/api/v2";

  protected authHeaders() {
    return { Authorization: `Bearer ${this.env("INSTANTLY_API_KEY")}` };
  }

  async verify() {
    try {
      await this.request({ path: "/campaigns", query: { limit: 1 } });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

  /** Add up to 1,000 leads to a campaign. */
  addLeads(campaignId: string, leads: Array<{ email: string; first_name?: string; company_name?: string; custom_variables?: Record<string, unknown> }>) {
    return this.request({ method: "POST", path: "/leads/bulk", body: { campaign_id: campaignId, leads } });
  }

  /** Pause a lead's sequence (on reply). */
  pauseLead(leadId: string) {
    return this.request({ method: "PATCH", path: `/leads/${leadId}`, body: { status: "paused" } });
  }

  /** Campaign open/click/reply analytics. */
  analytics(campaignId: string) {
    return this.request({ path: `/campaigns/${campaignId}/analytics` });
  }

  /** Per-domain/account vitals: bounce + warmup status (nightly health sweep). */
  vitals(accountId: string) {
    return this.request({ path: `/accounts/${accountId}/vitals` });
  }

  /** Blacklist + SpamAssassin inbox-placement test. */
  inboxPlacementTest(payload: Record<string, unknown>) {
    return this.request({ method: "POST", path: "/inbox-placement-tests", body: payload });
  }

  /** DNC mirror: add an email to the workspace block-list. */
  blocklistAdd(email: string) {
    return this.request({ method: "POST", path: "/block-list", body: { email } });
  }
}
