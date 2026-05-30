/**
 * RecruiterOS · Providers · Telnyx (SMS 10DLC + voice with AMD)
 * Base: https://api.telnyx.com/v2 · Auth: Bearer.
 * Used for: raw 10DLC SMS, and the BD/recruiting voice dialer with Premium
 * answering-machine detection (humans -> warm transfer, machines -> voicemail).
 */

import { ProviderClient } from "./http";

export class TelnyxClient extends ProviderClient {
  id = "telnyx";
  label = "Telnyx 10DLC (SMS/voice)";
  protected envKeys = ["TELNYX_API_KEY"];
  protected baseUrl = "https://api.telnyx.com/v2";

  protected authHeaders() {
    return { Authorization: `Bearer ${this.env("TELNYX_API_KEY")}` };
  }

  async verify() {
    try {
      await this.request({ path: "/messaging_profiles", query: { "page[size]": 1 } });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

  /** Send an SMS from the configured 10DLC number. */
  sendSms(to: string, text: string) {
    return this.request({
      method: "POST",
      path: "/messages",
      body: {
        from: this.env("TELNYX_FROM_NUMBER"),
        to,
        text,
        messaging_profile_id: this.env("TELNYX_MESSAGING_PROFILE_ID") || undefined,
      },
    });
  }

  /**
   * Place an outbound call with Premium answering-machine detection.
   * On `call.machine.detection.ended`, the webhook decides: human -> transfer,
   * machine -> voicemail drop.
   */
  dialWithAmd(to: string, connectionId: string, webhookUrl: string) {
    return this.request({
      method: "POST",
      path: "/calls",
      body: {
        to,
        from: this.env("TELNYX_FROM_NUMBER"),
        connection_id: connectionId,
        answering_machine_detection: "premium",
        webhook_url: webhookUrl,
      },
    });
  }
}
