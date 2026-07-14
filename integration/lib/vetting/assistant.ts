/**
 * RecruitersOS · AI Vetting · Voice-engine provisioning (Telnyx AI Assistant)
 *
 * Turns a vetting desk into a live, callable agent. This is the ONLY module that
 * knows the engine is Telnyx AI Assistant — the rest of the feature is engine-
 * agnostic, so swapping to another managed Voice-AI later is a one-file change.
 *
 * Provisioning is idempotent: create the assistant on first sync, update it on
 * every later sync, then bind the desk's inbound number to it. It inherits the
 * provider's dry-run contract — with no TELNYX_API_KEY the calls no-op and we
 * stamp a synthetic assistant id so the rest of the flow (UI, status) still works
 * end to end in dev.
 *
 * The voice settings carry the human-likeness timing the prompt can't express:
 * the cloned ElevenLabs voice, barge-in (interruptions), turn detection, and
 * natural-pause generation. The CONVERSATION rules live in the instructions
 * (see prompt.ts); the VOICE rules live here.
 */

import { telnyx } from "../providers";
import { cred } from "../providers/http";
import { withWorkspaceCreds } from "../connected";
import type { AssistantConfig } from "../providers/telnyx";
import { clampVoiceTuning, clampTurnTuning, type VettingDesk } from "./types";
import { buildAssistantInstructions, buildGreeting } from "./prompt";

function appUrl(): string {
  return process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co";
}

/** Telnyx voice selector for the recruiter's cloned ElevenLabs voice. */
function voiceSelector(desk: VettingDesk): string {
  const vid = desk.voiceId || cred("VOICE_CLONE_VOICE_ID");
  // ElevenLabs voices are addressed as "ElevenLabs.<voice_id>" on Telnyx; fall
  // back to a natural Telnyx neural voice when no clone is set yet.
  return vid ? `ElevenLabs.${vid}` : "Telnyx.KokoroTTS.af_heart";
}

/** Build the full assistant config from a desk. */
export function buildAssistantConfig(desk: VettingDesk): AssistantConfig {
  return {
    name: `AI Vetting · ${desk.roleTitle || desk.name}`.slice(0, 120),
    model: process.env.RECRUITEROS_VETTING_ENGINE_MODEL || "meta-llama/Llama-3.3-70B-Instruct",
    instructions: buildAssistantInstructions(desk),
    greeting: buildGreeting(desk),
    voice: voiceSelector(desk),
    // Human delivery knobs from the desk's tunable VoiceTuning (Optimizer tab);
    // clampVoiceTuning defaults any unset desk to the phone-realism sweet spot.
    // Telnyx field note (verified against their OpenAPI spec 2026-07-14): the
    // ElevenLabs expressiveness knob is `temperature` on Telnyx — there is NO
    // `stability` field. Temperature is the inverse (higher = livelier), so
    // stability 0.40 maps to temperature 0.60. Everything else passes straight.
    voice_settings: (() => {
      const t = clampVoiceTuning(desk.voiceTuning);
      return {
        api_key_ref: cred("TELNYX_ELEVENLABS_KEY_REF") || undefined,
        temperature: Math.round((1 - t.stability) * 100) / 100,
        similarity_boost: t.similarityBoost,
        style: t.style,
        speed: t.speed,
        use_speaker_boost: t.speakerBoost,
      };
    })(),
    // Barge-in + turn pacing from the desk's TurnTuning (Optimizer tab). Telnyx
    // has no numeric "interruption sensitivity"; what it does have is the
    // start-speaking plan (how long the agent waits before taking its turn), so
    // the sensitivity slider maps onto those waits — anchored so the default
    // slider position (0.6) lands exactly on Telnyx's documented defaults
    // (wait 0.4s, no-punctuation endpoint 1.5s).
    interruption_settings: (() => {
      const tt = clampTurnTuning(desk.turnTuning);
      const s = tt.interruptionSensitivity;
      const r2 = (n: number) => Math.round(n * 100) / 100;
      return {
        enable: tt.interruptions,
        disable_greeting_interruption: false,
        start_speaking_plan: {
          wait_seconds: r2(Math.max(0.2, 0.7 - 0.5 * s)),
          transcription_endpointing_plan: {
            on_punctuation_seconds: 0.1,
            on_no_punctuation_seconds: r2(Math.max(0.8, 2.1 - 1.0 * s)),
            on_number_seconds: 0.5,
          },
        },
      };
    })(),
    // Resolve who's calling (name + LinkedIn talking points) by caller ID.
    dynamic_variables_webhook_url: `${appUrl()}/api/vetting/context`,
    // Record + transcribe, and post the finished call to us for scoring.
    transcription: { model: "distil-whisper/distil-large-v3" },
    insight_settings: { webhook_url: `${appUrl()}/api/vetting/webhook` },
    telephony_settings: (() => {
      const tt = clampTurnTuning(desk.turnTuning);
      return {
        supports_unauthenticated_web_calls: false,
        // Clean caller audio before STT — free transcription accuracy.
        noise_suppression: "krisp",
        // Gentle check-in after this much caller silence (the check-in WORDING
        // lives in the prompt — Telnyx has no custom reminder-text field).
        user_idle_reply_secs: tt.idleTimeoutSec,
        // Hard stop on a truly dead line so a forgotten call can't bill for hours.
        user_idle_timeout_secs: Math.min(600, Math.max(60, tt.idleTimeoutSec * 8)),
      };
    })(),
  };
}

export interface ProvisionResult {
  assistantId?: string;
  dryRun: boolean;
  numberBound: boolean;
  error?: string;
}

/**
 * Create-or-update the desk's assistant and bind its inbound number. Idempotent:
 * pass the desk's existing assistantId to update in place. Never throws — returns
 * an error string the route can surface — so a Telnyx hiccup can't 500 the UI.
 */
export async function provisionDesk(desk: VettingDesk): Promise<ProvisionResult> {
  const config = buildAssistantConfig(desk);

  try {
    // Isolation: a customer's AI Vetting desk is provisioned on THEIR Telnyx
    // account, never the operator's env key.
    return await withWorkspaceCreds(desk.workspaceId, async () => {
      let assistantId = desk.assistantId;
      let dryRun = false;

      if (assistantId) {
        const res: any = await telnyx.updateAssistant(assistantId, config);
        dryRun = Boolean(res?.dryRun);
      } else {
        const res: any = await telnyx.createAssistant(config);
        dryRun = Boolean(res?.dryRun);
        // In dry-run we mint a synthetic id so the desk still flips to "live" in dev.
        assistantId = res?.data?.id ?? res?.id ?? (dryRun ? `dry_${desk.id}` : undefined);
      }

      if (!assistantId) {
        return { dryRun, numberBound: false, error: "no_assistant_id" };
      }

      let numberBound = false;
      if (desk.phoneNumber) {
        const bind: any = await telnyx.assignNumberToAssistant(assistantId, desk.phoneNumber);
        numberBound = !bind?.error;
      }

      return { assistantId, dryRun, numberBound };
    });
  } catch (e: any) {
    return { dryRun: false, numberBound: false, error: e?.message || "provision_failed" };
  }
}

/** Tear down an assistant when a desk is deleted (best-effort, never throws). */
export async function deprovisionDesk(desk: VettingDesk): Promise<void> {
  if (!desk.assistantId || desk.assistantId.startsWith("dry_")) return;
  try {
    await withWorkspaceCreds(desk.workspaceId, () => telnyx.deleteAssistant(desk.assistantId!));
  } catch {
    /* best-effort */
  }
}
