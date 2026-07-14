/**
 * RecruitersOS · AI Vetting · Tuned voice preview ("hear it before you save")
 *
 * Renders short audio through the desk's ACTUAL cloned ElevenLabs voice at the
 * EXACT VoiceTuning being edited, so the operator tunes by ear, not by number.
 * Two uses:
 *
 *   synthesizeTunedSample(desk, tuning)  -> one representative recruiter line
 *   rehearseSimAudio(desk, turns)        -> the agent's turns from a stress-test
 *                                           transcript, clip per turn, so a sim
 *                                           can be HEARD in the cloned voice
 *
 * Direct ElevenLabs TTS call (same key the Voice Drops path uses via
 * VOICE_CLONE_API_KEY) rather than the voice lib's synthesize(), because that
 * path pins its own hardcoded voice_settings - the whole point here is to hear
 * the DESK's settings. Uses multilingual v2: previews are pre-rendered, not
 * real-time, so quality beats latency. Dry-run contract: no key or no voice id
 * returns { dryRun: true } and the UI explains instead of erroring.
 */

import { cred } from "../providers/http";
import { withWorkspaceCreds } from "../connected";
import type { VettingDesk, VoiceTuning, TranscriptTurn } from "./types";
import { clampVoiceTuning } from "./types";

const ELEVEN_BASE = "https://api.elevenlabs.io/v1";
/** Quality tier: previews are one-off renders, latency is irrelevant. */
const PREVIEW_MODEL = "eleven_multilingual_v2";
/** Cap rehearsal clips so a long sim can't run up minutes of TTS spend. */
const MAX_REHEARSAL_CLIPS = 6;

export interface TunedClip {
  /** Base64 mp3, ready for a data: URL in the browser. */
  audioBase64: string;
  contentType: string;
  /** The text that was spoken (shown alongside the player). */
  text: string;
}

export interface TunedPreviewResult {
  clips: TunedClip[];
  dryRun: boolean;
  /** Set when dry-running: which prerequisite is missing. */
  hint?: string;
}

/**
 * A sample line that exercises the realism levers: the caller's name, an
 * acknowledgment before a question, a spelled-out number, and an ellipsis
 * hesitation - the same habits the agent prompt enforces.
 */
export function sampleLine(desk: VettingDesk): string {
  const who = desk.persona.agentName || "Ryan";
  const role = desk.roleTitle || "the role";
  return `Hey Jordan, this is ${who}. That makes sense... okay, so on the ${role} side, you mentioned about six years running the number. Walk me through the last two.`;
}

async function synthOne(
  apiKey: string,
  voiceId: string,
  tuning: VoiceTuning,
  text: string,
): Promise<TunedClip | null> {
  const res = await fetch(`${ELEVEN_BASE}/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text: text.slice(0, 600),
      model_id: PREVIEW_MODEL,
      voice_settings: {
        stability: tuning.stability,
        similarity_boost: tuning.similarityBoost,
        style: tuning.style,
        speed: tuning.speed,
        use_speaker_boost: tuning.speakerBoost,
      },
    }),
  });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return { audioBase64: buf.toString("base64"), contentType: "audio/mpeg", text };
}

/** One representative line at the given (unsaved) tuning. */
export async function synthesizeTunedSample(
  desk: VettingDesk,
  tuning?: Partial<VoiceTuning> | null,
  customText?: string,
): Promise<TunedPreviewResult> {
  return withWorkspaceCreds(desk.workspaceId, async () => {
    const apiKey = cred("VOICE_CLONE_API_KEY").trim();
    const voiceId = (desk.voiceId || cred("VOICE_CLONE_VOICE_ID")).trim();
    if (!apiKey) return { clips: [], dryRun: true, hint: "no_voice_key" };
    if (!voiceId) return { clips: [], dryRun: true, hint: "no_voice_id" };
    const text = (customText || "").trim().slice(0, 400) || sampleLine(desk);
    const clip = await synthOne(apiKey, voiceId, clampVoiceTuning(tuning ?? desk.voiceTuning), text);
    if (!clip) return { clips: [], dryRun: false, hint: "synthesis_failed" };
    return { clips: [clip], dryRun: false };
  });
}

/**
 * Render the AGENT turns of a stress-test transcript in the cloned voice at
 * the desk's current tuning - hear the sim, not just read it. Clips render
 * concurrently and keep transcript order; a failed clip is skipped.
 */
export async function rehearseSimAudio(
  desk: VettingDesk,
  turns: TranscriptTurn[],
): Promise<TunedPreviewResult> {
  return withWorkspaceCreds(desk.workspaceId, async () => {
    const apiKey = cred("VOICE_CLONE_API_KEY").trim();
    const voiceId = (desk.voiceId || cred("VOICE_CLONE_VOICE_ID")).trim();
    if (!apiKey) return { clips: [], dryRun: true, hint: "no_voice_key" };
    if (!voiceId) return { clips: [], dryRun: true, hint: "no_voice_id" };
    const tuning = clampVoiceTuning(desk.voiceTuning);
    const agentTurns = turns.filter((t) => t.role === "agent" && t.text.trim()).slice(0, MAX_REHEARSAL_CLIPS);
    if (!agentTurns.length) return { clips: [], dryRun: false, hint: "no_agent_turns" };
    const rendered = await Promise.all(agentTurns.map((t) => synthOne(apiKey, voiceId, tuning, t.text)));
    const clips = rendered.filter((c): c is TunedClip => Boolean(c));
    return { clips, dryRun: false, hint: clips.length ? undefined : "synthesis_failed" };
  });
}
