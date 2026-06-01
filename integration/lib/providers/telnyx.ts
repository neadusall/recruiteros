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

  /**
   * Telnyx Number Lookup. Returns the carrier object incl. `type`
   * (mobile / landline / voip / toll-free), the cheap + reliable way to split a
   * found number into the mobile vs landline field. ~$0.0025/query (line-type).
   *   GET /number_lookup/{phone}?type=carrier
   */
  numberLookup(phoneNumber: string) {
    return this.request({
      path: `/number_lookup/${encodeURIComponent(phoneNumber)}`,
      query: { type: "carrier" },
    });
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
   *
   * `clientState` is round-tripped (base64 JSON) on every subsequent webhook for
   * this call, so the handler can recover the workspace / prospect to bill and
   * route without its own store.
   */
  dialWithAmd(to: string, connectionId: string, webhookUrl: string, clientState?: Record<string, unknown>) {
    return this.request({
      method: "POST",
      path: "/calls",
      body: {
        to,
        from: this.env("TELNYX_FROM_NUMBER"),
        connection_id: connectionId,
        answering_machine_detection: "premium",
        webhook_url: webhookUrl,
        client_state: clientState ? encodeClientState(clientState) : undefined,
      },
    });
  }

  /* ----- Call-control actions (the voice webhook acts on the AMD result) ----- */

  /**
   * Warm-transfer a live human to the recruiter. Telnyx bridges a new leg to
   * `to`; `from` is the caller ID the recruiter sees (defaults to our number).
   *   POST /calls/{call_control_id}/actions/transfer
   */
  transferCall(callControlId: string, to: string, from?: string) {
    return this.request({
      method: "POST",
      path: `/calls/${encodeURIComponent(callControlId)}/actions/transfer`,
      body: { to, from: from || this.env("TELNYX_FROM_NUMBER") },
    });
  }

  /**
   * Drop a pre-recorded voicemail. Called after the machine greeting/beep ends so
   * the message lands on the recording, not over the greeting.
   *   POST /calls/{call_control_id}/actions/playback_start
   */
  playAudio(callControlId: string, audioUrl: string) {
    return this.request({
      method: "POST",
      path: `/calls/${encodeURIComponent(callControlId)}/actions/playback_start`,
      body: { audio_url: audioUrl },
    });
  }

  /** Hang up a leg (after the voicemail drop finishes, or to abandon). */
  hangup(callControlId: string) {
    return this.request({
      method: "POST",
      path: `/calls/${encodeURIComponent(callControlId)}/actions/hangup`,
      body: {},
    });
  }
}

/** Telnyx echoes client_state back base64-encoded on every webhook for a call. */
export function encodeClientState(state: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64");
}

/** Decode the client_state Telnyx round-trips on a voice webhook (safe on junk). */
export function decodeClientState(raw?: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8")) ?? {};
  } catch {
    return {};
  }
}
