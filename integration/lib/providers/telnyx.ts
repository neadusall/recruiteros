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

  /**
   * List the phone numbers on this Telnyx account (paginated). Used by AI
   * Vetting to offer the operator a pick-list of their real numbers to bind to a
   * job description, instead of typing one by hand.
   *   GET /phone_numbers?page[size]=&page[number]=
   */
  listPhoneNumbers(pageSize = 100, pageNumber = 1) {
    return this.request({
      path: "/phone_numbers",
      query: { "page[size]": pageSize, "page[number]": pageNumber },
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
    const from = this.env("TELNYX_FROM_NUMBER");
    // Preflight the inputs Telnyx would 422 on, but only when we're actually going
    // to dial for real (configured). Unconfigured stays a dry-run via request().
    // A clear "connection not set / number not E.164" beats an opaque telnyx_422.
    if (this.configured()) {
      const problems: string[] = [];
      if (!from) problems.push("caller-ID number (TELNYX_FROM_NUMBER) is not set");
      if (!connectionId) problems.push("call-control connection (TELNYX_CONNECTION_ID) is not set");
      const dest = (to || "").trim();
      if (!dest) problems.push("destination number is empty");
      else if (!/^\+[1-9]\d{7,14}$/.test(dest)) problems.push(`destination "${to}" is not E.164 (e.g. +13105551234)`);
      if (problems.length) throw new Error(`telnyx_config: ${problems.join("; ")}`);
    }
    return this.request({
      method: "POST",
      path: "/calls",
      body: {
        to: (to || "").trim(),
        from,
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

  /**
   * Speak a line with Telnyx's built-in TTS. Used for the HONEST human-answer
   * identifier and sign-off ("This is Ryan with Executive Search — is this
   * Hector?" / "Sorry, wrong number. Thanks.") so the cloned-voice budget is
   * reserved for the actual voicemail drops. Emits `call.speak.ended`.
   *   POST /calls/{call_control_id}/actions/speak
   */
  speak(callControlId: string, text: string, opts?: { voice?: string; language?: string }) {
    return this.request({
      method: "POST",
      path: `/calls/${encodeURIComponent(callControlId)}/actions/speak`,
      body: { payload: text, voice: opts?.voice ?? "female", language: opts?.language ?? "en-US" },
    });
  }

  /* ===================================================================== *
   *  AI Assistants (the INBOUND conversational agent — AI Vetting)
   *
   *  Telnyx's managed Voice-AI runs the real-time STT -> LLM -> TTS loop with
   *  barge-in and turn detection for us; we supply the instructions, the cloned
   *  ElevenLabs voice, the greeting, and two webhooks:
   *    - dynamic_variables_webhook_url: called when a caller connects, so we can
   *      return who they are (name + LinkedIn talking points) keyed by caller ID.
   *    - the insight/transcription webhook: the finished transcript + recording,
   *      which we score.
   *
   *  Endpoints follow Telnyx's /v2/ai/assistants surface. Treat number<->assistant
   *  assignment as the operator-verify seam: confirm it against the current
   *  Telnyx console/API for your account before going live.
   * ===================================================================== */

  /** Create an AI Assistant. Returns the created resource (incl. its id). */
  createAssistant(body: AssistantConfig) {
    return this.request({ method: "POST", path: "/ai/assistants", body });
  }

  /** Update an existing assistant's config (instructions/voice/greeting/webhooks). */
  updateAssistant(assistantId: string, body: Partial<AssistantConfig>) {
    return this.request({ method: "POST", path: `/ai/assistants/${encodeURIComponent(assistantId)}`, body });
  }

  deleteAssistant(assistantId: string) {
    return this.request({ method: "DELETE", path: `/ai/assistants/${encodeURIComponent(assistantId)}` });
  }

  /**
   * Bind an inbound phone number to an assistant so calls to it are answered by
   * the agent. Telnyx exposes this as the assistant's phone-numbers collection.
   */
  assignNumberToAssistant(assistantId: string, phoneNumber: string) {
    return this.request({
      method: "POST",
      path: `/ai/assistants/${encodeURIComponent(assistantId)}/phone_numbers`,
      body: { phone_number: phoneNumber },
    });
  }
}

/** Shape of the Telnyx AI Assistant config we push (the fields we use). */
export interface AssistantConfig {
  name: string;
  /** Underlying LLM the assistant reasons with (Telnyx-hosted model id). */
  model?: string;
  /** The full system prompt (human-likeness spec + JD + caller context slots). */
  instructions: string;
  /** First line spoken on answer; may contain {{dynamic_variables}}. */
  greeting?: string;
  /** Voice selector, e.g. "ElevenLabs.<voiceId>" for the recruiter's cloned voice. */
  voice?: string;
  voice_settings?: Record<string, unknown>;
  /** Called per-call to resolve {{dynamic_variables}} (caller identity/context). */
  dynamic_variables_webhook_url?: string;
  /** Where Telnyx posts the finished transcript + recording for scoring. */
  insight_settings?: Record<string, unknown>;
  transcription?: Record<string, unknown>;
  telephony_settings?: Record<string, unknown>;
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
