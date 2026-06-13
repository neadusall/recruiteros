/**
 * RecruitersOS · Providers · SalesRobot (LinkedIn channel, alt)
 * Base: https://app.salesrobot.co/public · Auth: two headers (authorization + customeruuid).
 * Used for: adding prospects to a SalesRobot campaign, pausing on reply, manual
 * DM replies, tagging (classification), and removal (DNC mirror).
 *
 * Gotchas baked in from the reference: profileUrl wins over email; custom columns
 * are a stringified JSON payload; campaign name must match exactly.
 */

import { ProviderClient } from "./http";

export class SalesRobotClient extends ProviderClient {
  id = "salesrobot";
  label = "SalesRobot (LinkedIn)";
  protected envKeys = ["SALESROBOT_API_KEY", "SALESROBOT_CUSTOMER_UUID"];
  protected baseUrl = "https://app.salesrobot.co/public";

  protected authHeaders() {
    return {
      authorization: this.env("SALESROBOT_API_KEY"),
      customeruuid: this.env("SALESROBOT_CUSTOMER_UUID"),
    };
  }

  async verify() {
    // No public health endpoint; configured + well-formed creds is the gate.
    return { ok: this.configured(), error: this.configured() ? undefined : "not_configured" };
  }

  addProspect(campaignName: string, prospect: { profileUrl: string; firstName?: string; customColumns?: Record<string, unknown> }) {
    return this.request({
      method: "POST",
      path: "/campaign/addProspect",
      body: {
        campaignName,
        profileUrl: prospect.profileUrl,
        firstName: prospect.firstName,
        customColumns: prospect.customColumns ? JSON.stringify(prospect.customColumns) : undefined,
      },
    });
  }

  pauseSequence(profileUrl: string) {
    return this.request({ method: "POST", path: "/pauseSequence", body: { profileUrl } });
  }

  replyToProspect(profileUrl: string, message: string) {
    return this.request({ method: "POST", path: "/replyToProspect", body: { profileUrl, message } });
  }

  addTag(profileUrl: string, tag: string) {
    return this.request({ method: "POST", path: "/addTag", body: { profileUrl, tag } });
  }

  removeProspect(profileUrl: string) {
    return this.request({ method: "POST", path: "/removeProspect", body: { profileUrl } });
  }
}
