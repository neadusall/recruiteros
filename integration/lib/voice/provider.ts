/**
 * RecruiterOS · Voice Drops · Voice-clone provider (pluggable)
 *
 * One small interface so the rest of the engine never knows which TTS/clone
 * vendor is wired. Ships an ElevenLabs-class adapter behind env keys; runs as a
 * safe dry-run (no audio, no spend) when unconfigured, exactly like the
 * ProviderClient HTTP base does for every other integration.
 *
 *   VOICE_CLONE_PROVIDER   provider id (default "elevenlabs")
 *   VOICE_CLONE_API_KEY    api key
 *   VOICE_CLONE_VOICE_ID   default cloned voice id (the operator's own voice)
 *
 * The cloned voice MUST be the operator's own, captured with the recorded
 * consent step (see VoiceConsent) — createVoice is only ever called from the
 * consent flow.
 */

export interface SynthResult {
  /** Rendered audio bytes (undefined on dry-run). */
  audio?: Buffer;
  contentType: string;
  dryRun: boolean;
}

export interface CreateVoiceResult {
  voiceId?: string;
  dryRun: boolean;
  error?: string;
}

export interface VoiceCloneClient {
  id: string;
  configured(): boolean;
  /** Synthesize one line in `voiceId` (defaults to the configured voice). */
  synthesize(text: string, voiceId?: string): Promise<SynthResult>;
  /** Mint a cloned voice from a consent recording (operator's own voice only). */
  createVoice(input: { name: string; sample: Buffer; contentType?: string }): Promise<CreateVoiceResult>;
}

/** ElevenLabs-class adapter (text-to-speech + instant voice clone). */
class ElevenLabsClient implements VoiceCloneClient {
  id = "elevenlabs";
  private base = "https://api.elevenlabs.io/v1";

  private key(): string {
    return process.env.VOICE_CLONE_API_KEY ?? "";
  }
  configured(): boolean {
    return Boolean(this.key());
  }
  private defaultVoice(): string {
    return process.env.VOICE_CLONE_VOICE_ID ?? "";
  }

  async synthesize(text: string, voiceId?: string): Promise<SynthResult> {
    const vid = voiceId || this.defaultVoice();
    if (!this.configured() || !vid) {
      console.info(`[voice-clone:dry] synth "${text.slice(0, 48)}" (voice=${vid || "unset"})`);
      return { contentType: "audio/mpeg", dryRun: true };
    }
    const res = await fetch(`${this.base}/text-to-speech/${encodeURIComponent(vid)}`, {
      method: "POST",
      headers: { "xi-api-key": this.key(), "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!res.ok) {
      throw new Error(`voice_clone_${res.status}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    return { audio, contentType: "audio/mpeg", dryRun: false };
  }

  async createVoice(input: { name: string; sample: Buffer; contentType?: string }): Promise<CreateVoiceResult> {
    if (!this.configured()) {
      console.info(`[voice-clone:dry] createVoice "${input.name}"`);
      return { dryRun: true };
    }
    const form = new FormData();
    form.append("name", input.name);
    form.append(
      "files",
      new Blob([new Uint8Array(input.sample)], { type: input.contentType || "audio/mpeg" }),
      "consent.mp3",
    );
    const res = await fetch(`${this.base}/voices/add`, {
      method: "POST",
      headers: { "xi-api-key": this.key() },
      body: form as any,
    });
    if (!res.ok) return { dryRun: false, error: `voice_clone_${res.status}` };
    const data: any = await res.json().catch(() => ({}));
    return { voiceId: data?.voice_id, dryRun: false };
  }
}

let singleton: VoiceCloneClient | null = null;

/** The configured voice-clone client (one per process). */
export function getVoiceClient(): VoiceCloneClient {
  if (!singleton) {
    // Only ElevenLabs is shipped; the env var is the seam to add more adapters.
    singleton = new ElevenLabsClient();
  }
  return singleton;
}
