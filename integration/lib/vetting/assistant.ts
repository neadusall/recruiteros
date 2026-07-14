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
import { clampVoiceTuning, type VettingDesk } from "./types";
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
    // Human timing knobs: low-latency cloned voice, allow the caller to barge in,
    // detect turns on natural pauses rather than fixed silence, slight variation.
    // The delivery values are the desk's tunable VoiceTuning (Optimizer tab);
    // clampVoiceTuning defaults any unset desk to the phone-realism sweet spot.
    voice_settings: (() => {
      const t = clampVoiceTuning(desk.voiceTuning);
      return {
        api_key_ref: cred("TELNYX_ELEVENLABS_KEY_REF") || undefined,
        stability: t.stability,
        similarity_boost: t.similarityBoost,
        style: t.style,
        speed: t.speed,
        use_speaker_boost: t.speakerBoost,
      };
    })(),
    // Resolve who's calling (name + LinkedIn talking points) by caller ID.
    dynamic_variables_webhook_url: `${appUrl()}/api/vetting/context`,
    // Record + transcribe, and post the finished call to us for scoring.
    transcription: { model: "distil-whisper/distil-large-v3" },
    insight_settings: { webhook_url: `${appUrl()}/api/vetting/webhook` },
    telephony_settings: {
      // Let the caller interrupt the agent (barge-in) — the single strongest
      // human-realism signal in the spec.
      supports_unauthenticated_web_calls: false,
    },
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
