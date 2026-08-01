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
import type { VettingDesk } from "./types";
import { buildAssistantInstructions, buildGreeting } from "./prompt";

function appUrl(): string {
  return process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co";
}

/**
 * Telnyx-hosted LLM the assistant reasons with. Telnyx's model catalog rotates
 * (ids get retired), so this is only a starting point — resolveEngineModel()
 * verifies it against the live account before provisioning.
 */
const DEFAULT_ENGINE_MODEL = "meta-llama/Llama-3.3-70B-Instruct";

function configuredEngineModel(): string {
  return process.env.RECRUITEROS_VETTING_ENGINE_MODEL || DEFAULT_ENGINE_MODEL;
}

/**
 * True when the desk will speak in the recruiter's CLONED voice — needs both a
 * voice id AND the ElevenLabs key stored as a Telnyx integration secret. When
 * false, Telnyx answers in a natural stock voice instead (still fully functional).
 */
export function voiceIsCloned(desk: VettingDesk): boolean {
  const vid = desk.voiceId || cred("VOICE_CLONE_VOICE_ID");
  return Boolean(vid && cred("TELNYX_ELEVENLABS_KEY_REF"));
}

/**
 * Resolve the engine model against the live Telnyx account so a retired default
 * can't hard-fail provisioning. If the configured model exists on the account,
 * use it; if not, fall back to the first model the account actually offers and
 * log the swap. Never throws — on dry-run or any lookup failure it returns the
 * configured id unchanged (the create call then surfaces any real error).
 */
export async function resolveEngineModel(): Promise<string> {
  const want = configuredEngineModel();
  try {
    const res: any = await telnyx.listModels();
    if (res?.dryRun) return want;
    const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res?.models) ? res.models : [];
    const ids = rows.map((m) => String(m?.id ?? m?.name ?? "")).filter(Boolean);
    if (!ids.length) return want;
    if (ids.includes(want)) return want;
    const fallback = ids[0];
    console.warn(
      `[vetting] engine model "${want}" not in Telnyx account catalog; falling back to "${fallback}". ` +
        `Set RECRUITEROS_VETTING_ENGINE_MODEL to one of: ${ids.slice(0, 8).join(", ")}`,
    );
    return fallback;
  } catch {
    return want;
  }
}

/** Telnyx voice selector for the recruiter's cloned ElevenLabs voice. */
function voiceSelector(desk: VettingDesk): string {
  const vid = desk.voiceId || cred("VOICE_CLONE_VOICE_ID");
  // ElevenLabs voices are addressed as "ElevenLabs.<voice_id>" on Telnyx AND require
  // the ElevenLabs API key stored as a Telnyx integration secret, referenced by
  // voice_settings.api_key_ref. Without that secret the clone can't authenticate, so
  // only select ElevenLabs when BOTH are present; otherwise use a natural Telnyx voice.
  const keyRef = cred("TELNYX_ELEVENLABS_KEY_REF");
  return vid && keyRef ? `ElevenLabs.${vid}` : "Telnyx.KokoroTTS.af_heart";
}

/** Build the full assistant config from a desk. */
export function buildAssistantConfig(desk: VettingDesk): AssistantConfig {
  return {
    name: `AI Vetting · ${desk.roleTitle || desk.name}`.slice(0, 120),
    model: configuredEngineModel(),
    instructions: buildAssistantInstructions(desk),
    greeting: buildGreeting(desk),
    // Telnyx puts the voice selector + ElevenLabs auth INSIDE voice_settings (there is
    // no top-level `voice` field). api_key_ref references the ElevenLabs API key stored
    // as a Telnyx integration secret; similarity_boost/style shape the delivery.
    voice_settings: {
      voice: voiceSelector(desk),
      api_key_ref: cred("TELNYX_ELEVENLABS_KEY_REF") || undefined,
      similarity_boost: 0.85,
      style: 0.2,
    },
    // Resolve who's calling (name + LinkedIn talking points) by caller ID.
    dynamic_variables_webhook_url: `${appUrl()}/api/vetting/context`,
    // Transcribe with a valid Telnyx STT model, and record the call so the finished
    // transcript + audio are retrievable from the Conversations API for scoring.
    transcription: {
      model: process.env.RECRUITEROS_VETTING_STT_MODEL || "distil-whisper/distil-large-v2",
    },
    telephony_settings: {
      supports_unauthenticated_web_calls: false,
      recording_settings: { enabled: true, stop_on_conversation_end: true },
    },
  };
}

export interface ProvisionResult {
  assistantId?: string;
  dryRun: boolean;
  numberBound: boolean;
  /** Which model the assistant was actually provisioned on (post-resolution). */
  model?: string;
  /** "cloned" = the recruiter's ElevenLabs voice; "fallback" = a stock Telnyx voice. */
  voiceMode?: "cloned" | "fallback";
  error?: string;
}

/**
 * Create-or-update the desk's assistant and bind its inbound number. Idempotent:
 * pass the desk's existing assistantId to update in place. Never throws — returns
 * an error string the route can surface — so a Telnyx hiccup can't 500 the UI.
 */
export async function provisionDesk(desk: VettingDesk): Promise<ProvisionResult> {
  const config = buildAssistantConfig(desk);
  const voiceMode: ProvisionResult["voiceMode"] = voiceIsCloned(desk) ? "cloned" : "fallback";

  try {
    // Isolation: a customer's AI Vetting desk is provisioned on THEIR Telnyx
    // account, never the operator's env key.
    return await withWorkspaceCreds(desk.workspaceId, async () => {
      // Self-heal the model against the live account so a retired default id
      // can't hard-fail the create call.
      config.model = await resolveEngineModel();

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
        return { dryRun, numberBound: false, model: config.model, voiceMode, error: "no_assistant_id" };
      }

      let numberBound = false;
      if (desk.phoneNumber) {
        const bind: any = await telnyx.assignNumberToAssistant(assistantId, desk.phoneNumber);
        numberBound = !bind?.error;
      }

      return { assistantId, dryRun, numberBound, model: config.model, voiceMode };
    });
  } catch (e: any) {
    return { dryRun: false, numberBound: false, voiceMode, error: e?.message || "provision_failed" };
  }
}

/**
 * Tear down a desk's engine binding when it's deleted or detached (best-effort,
 * never throws). Frees the number's inbound route AND deletes the assistant, so the
 * number stops answering for this desk and can be reassigned to another JD.
 */
export async function deprovisionDesk(desk: VettingDesk): Promise<void> {
  const isDry = !desk.assistantId || desk.assistantId.startsWith("dry_");
  try {
    await withWorkspaceCreds(desk.workspaceId, async () => {
      // Unbind the number first so it stops routing to the (soon-deleted) assistant.
      if (desk.phoneNumber) {
        try {
          await telnyx.clearNumberConnection(desk.phoneNumber);
        } catch {
          /* ignore */
        }
      }
      if (!isDry) await telnyx.deleteAssistant(desk.assistantId!);
    });
  } catch {
    /* best-effort */
  }
}
