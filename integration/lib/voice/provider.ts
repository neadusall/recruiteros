/**
 * RecruiterOS · Voice Drops · Voice-clone provider (pluggable)
 *
 * One small interface so the rest of the engine never knows which TTS/clone
 * vendor is wired. Ships ElevenLabs AND Cartesia adapters behind env keys; runs
 * as a safe dry-run (no audio, no spend) when unconfigured, exactly like the
 * ProviderClient HTTP base does for every other integration.
 *
 * The fast path is bring-your-own-voice: a user pastes an ElevenLabs OR a
 * Cartesia voice id (see VoiceConsent.provider) and we synthesize against the
 * matching provider — no on-platform cloning/approval required.
 *
 *   VOICE_CLONE_PROVIDER   default provider id ("elevenlabs" | "cartesia")
 *   VOICE_CLONE_API_KEY    ElevenLabs api key
 *   VOICE_CLONE_VOICE_ID   default ElevenLabs voice id
 *   CARTESIA_API_KEY       Cartesia api key
 *   CARTESIA_VOICE_ID      default Cartesia voice id
 *   CARTESIA_MODEL         Cartesia model id (default "sonic-2")
 *   CARTESIA_VERSION       Cartesia API version header (default "2024-11-13")
 */

import { cred } from "../providers/http";

/** The TTS/clone vendors a voice id can belong to. */
export type VoiceProvider = "elevenlabs" | "cartesia";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One synthesis HTTP call with bounded retry. TTS/clone vendors rate-limit by
 * concurrency/quota (HTTP 429) and occasionally 5xx; a cloned voicemail is built
 * from several segments, so without backoff a momentary 429 fails the whole drop.
 * Retries 429/5xx a few times (honoring Retry-After), then surfaces
 * `voice_clone_<status>` so the caller degrades to the honest non-cloned drop.
 */
async function synthRequest(url: string, init: RequestInit): Promise<Response> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e: any) {
      // Network blip: retry a couple of times, then give up with a clear reason.
      if (attempt === maxAttempts) throw new Error(`voice_clone_network: ${e?.message || "fetch failed"}`);
      await sleep(Math.min(8000, 400 * 2 ** (attempt - 1)));
      continue;
    }
    if (res.ok) return res;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === maxAttempts) throw new Error(`voice_clone_${res.status}`);
    const ra = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(15000, ra * 1000) : Math.min(8000, 400 * 2 ** (attempt - 1));
    await sleep(waitMs);
  }
  // Unreachable (loop either returns or throws), but satisfies the type checker.
  throw new Error("voice_clone_exhausted");
}

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
  /** Live check that the API key actually works (so we know it'll deploy, not just dry-run). */
  verify(): Promise<{ ok: boolean; error?: string }>;
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
    return cred("VOICE_CLONE_API_KEY");
  }
  configured(): boolean {
    return Boolean(this.key());
  }
  private defaultVoice(): string {
    return cred("VOICE_CLONE_VOICE_ID");
  }

  async verify(): Promise<{ ok: boolean; error?: string }> {
    if (!this.configured()) return { ok: false, error: "no_api_key" };
    try {
      const res = await fetch(`${this.base}/user`, { headers: { "xi-api-key": this.key() } });
      return res.ok ? { ok: true } : { ok: false, error: `elevenlabs_${res.status}` };
    } catch (e: any) {
      return { ok: false, error: e?.message || "elevenlabs_error" };
    }
  }

  async synthesize(text: string, voiceId?: string): Promise<SynthResult> {
    const vid = voiceId || this.defaultVoice();
    if (!this.configured() || !vid) {
      console.info(`[voice-clone:dry] synth "${text.slice(0, 48)}" (voice=${vid || "unset"})`);
      return { contentType: "audio/mpeg", dryRun: true };
    }
    const res = await synthRequest(`${this.base}/text-to-speech/${encodeURIComponent(vid)}`, {
      method: "POST",
      headers: { "xi-api-key": this.key(), "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        // Mirrors the values dialed in on the ElevenLabs playground for this
        // voice (Ryan Nead). Drops are pre-rendered + cached, so we use the most
        // natural production model, not a low-latency one. eleven_turbo_v2 was
        // deprecated; multilingual v2 reads numbers/prosody more naturally.
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.46,
          similarity_boost: 0.36,
          style: 0.03,
          use_speaker_boost: false,
          speed: 0.97,
        },
      }),
    });
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

/**
 * Cartesia adapter (Sonic TTS, synthesize by voice id). Same dry-run contract as
 * ElevenLabs; outputs mp3 so it caches identically and plays straight to Telnyx.
 */
class CartesiaClient implements VoiceCloneClient {
  id = "cartesia";
  private base = "https://api.cartesia.ai";

  private key(): string {
    return cred("CARTESIA_API_KEY");
  }
  configured(): boolean {
    return Boolean(this.key());
  }
  private defaultVoice(): string {
    return cred("CARTESIA_VOICE_ID");
  }

  async verify(): Promise<{ ok: boolean; error?: string }> {
    if (!this.configured()) return { ok: false, error: "no_api_key" };
    try {
      const res = await fetch(`${this.base}/voices`, {
        headers: { "X-API-Key": this.key(), "Cartesia-Version": cred("CARTESIA_VERSION") || "2024-11-13" },
      });
      return res.ok ? { ok: true } : { ok: false, error: `cartesia_${res.status}` };
    } catch (e: any) {
      return { ok: false, error: e?.message || "cartesia_error" };
    }
  }

  async synthesize(text: string, voiceId?: string): Promise<SynthResult> {
    const vid = voiceId || this.defaultVoice();
    if (!this.configured() || !vid) {
      console.info(`[voice-clone:dry] cartesia synth "${text.slice(0, 48)}" (voice=${vid || "unset"})`);
      return { contentType: "audio/mpeg", dryRun: true };
    }
    const res = await synthRequest(`${this.base}/tts/bytes`, {
      method: "POST",
      headers: {
        "X-API-Key": this.key(),
        "Cartesia-Version": cred("CARTESIA_VERSION") || "2024-11-13",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_id: cred("CARTESIA_MODEL") || "sonic-2",
        transcript: text,
        voice: { mode: "id", id: vid },
        output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
      }),
    });
    const audio = Buffer.from(await res.arrayBuffer());
    return { audio, contentType: "audio/mpeg", dryRun: false };
  }

  // Bring-your-own-voice only: we never clone on Cartesia's side, users paste an
  // existing voice id. Left as a safe no-op so the interface is satisfied.
  async createVoice(): Promise<CreateVoiceResult> {
    return { dryRun: true, error: "cartesia_clone_unsupported" };
  }
}

const singletons: Partial<Record<VoiceProvider, VoiceCloneClient>> = {};

/** Resolve the voice-clone client for a provider (defaults to VOICE_CLONE_PROVIDER, else elevenlabs). */
export function getVoiceClientFor(provider?: VoiceProvider): VoiceCloneClient {
  const p: VoiceProvider =
    provider || ((cred("VOICE_CLONE_PROVIDER") as VoiceProvider) || "elevenlabs");
  if (!singletons[p]) singletons[p] = p === "cartesia" ? new CartesiaClient() : new ElevenLabsClient();
  return singletons[p]!;
}

/** The default voice-clone client (back-compat shim over getVoiceClientFor). */
export function getVoiceClient(): VoiceCloneClient {
  return getVoiceClientFor();
}

/** Configured-status for every provider — for the UI's "ready" checks. */
export function voiceProviderStatuses(): Array<{ id: VoiceProvider; configured: boolean }> {
  return (["elevenlabs", "cartesia"] as VoiceProvider[]).map((id) => ({
    id,
    configured: getVoiceClientFor(id).configured(),
  }));
}

/** Live key check for one provider (the "Test" button — proves it'll deploy). */
export function verifyVoiceProvider(provider?: VoiceProvider): Promise<{ ok: boolean; error?: string }> {
  return getVoiceClientFor(provider).verify();
}
