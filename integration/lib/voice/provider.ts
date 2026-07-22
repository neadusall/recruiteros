/**
 * RecruitersOS · Voice Drops · Voice-clone provider (pluggable)
 *
 * One small interface so the rest of the engine never knows which TTS/clone
 * vendor is wired. Ships ElevenLabs, Cartesia AND Hume (Octave) adapters behind
 * env keys; runs as a safe dry-run (no audio, no spend) when unconfigured,
 * exactly like the ProviderClient HTTP base does for every other integration.
 *
 * The fast path is bring-your-own-voice: a user pastes an ElevenLabs, Cartesia
 * OR Hume voice id (see VoiceConsent.provider) and we synthesize against the
 * matching provider — no on-platform cloning/approval required.
 *
 *   VOICE_CLONE_PROVIDER   default provider id ("elevenlabs" | "cartesia" | "hume")
 *   VOICE_CLONE_API_KEY    ElevenLabs api key
 *   VOICE_CLONE_VOICE_ID   default ElevenLabs voice id
 *   CARTESIA_API_KEY       Cartesia api key
 *   CARTESIA_VOICE_ID      default Cartesia voice id
 *   CARTESIA_MODEL         Cartesia model id (default "sonic-2")
 *   CARTESIA_VERSION       Cartesia API version header (default "2024-11-13")
 *   HUME_API_KEY           Hume api key
 *   HUME_VOICE_ID          default Hume voice id (Octave Voice Library / custom)
 *   HUME_VOICE_SOURCE      which Hume voice pool the id lives in
 *                          ("CUSTOM_VOICE" default | "HUME_AI")
 */

import { cred } from "../providers/http";

/** The TTS/clone vendors a voice id can belong to. */
export type VoiceProvider = "elevenlabs" | "cartesia" | "hume";

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

/** One selectable voice on the provider account (for the pick-a-voice browser). */
export interface ProviderVoice {
  voiceId: string;
  name: string;
  /** e.g. "cloned" | "professional" | "premade" | "generated" (provider-specific). */
  category?: string;
  /** Short public MP3 URL the UI can play as a sample, when the provider gives one. */
  previewUrl?: string;
}

export interface ListVoicesResult {
  voices: ProviderVoice[];
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
  /** The voices on this account, for the desk-form voice browser. Optional: not
   *  every provider exposes a listing, and callers must handle its absence. */
  listVoices?(): Promise<ListVoicesResult>;
}

/** ElevenLabs-class adapter (text-to-speech + instant voice clone). */
class ElevenLabsClient implements VoiceCloneClient {
  id = "elevenlabs";
  private base = "https://api.elevenlabs.io/v1";

  private key(): string {
    // Trim: keys pasted from the dashboard often carry a trailing space/newline,
    // which makes a perfectly valid key 401. The header must be the bare token.
    return cred("VOICE_CLONE_API_KEY").trim();
  }
  configured(): boolean {
    return Boolean(this.key());
  }
  private defaultVoice(): string {
    return cred("VOICE_CLONE_VOICE_ID").trim();
  }

  async verify(): Promise<{ ok: boolean; error?: string }> {
    if (!this.configured()) return { ok: false, error: "no_api_key" };
    // ElevenLabs returns 401 for BOTH a bad key AND a valid-but-scope-restricted
    // key, distinguished only by the JSON body's `detail.status`. A new key scoped
    // to e.g. "Text to Speech" 401s on /v1/user even though it synthesizes fine —
    // that must NOT read as "key broken". So probe a few reads and inspect the
    // body: `missing_permissions` proves the key authenticated (valid → accept it);
    // `invalid_api_key` is a genuinely bad key (fail fast); any 2xx → valid.
    const probes = ["/user", "/voices", "/models"];
    const k = this.key();
    let lastStatus = 0;
    for (const path of probes) {
      let res: Response;
      try {
        res = await fetch(`${this.base}${path}`, { headers: { "xi-api-key": k } });
      } catch (e: any) {
        console.error(`[voice-clone:elevenlabs] verify ${path} network error: ${e?.message || e}`);
        return { ok: false, error: e?.message || "elevenlabs_error" };
      }
      if (res.ok) return { ok: true };
      lastStatus = res.status;
      const rawBody = await res.text().catch(() => "");
      // TEMP DIAGNOSTIC: log exactly what ElevenLabs rejected so we can see whether
      // it's a bad key vs a missing scope. Logs key LENGTH only, never the key.
      console.error(
        `[voice-clone:elevenlabs] verify ${path} -> ${res.status}; keyLen=${k.length}; body=${rawBody.slice(0, 400)}`,
      );
      let detail = "";
      try {
        const d = JSON.parse(rawBody)?.detail;
        detail = d && typeof d === "object" && d.status ? String(d.status) : typeof d === "string" ? d : "";
      } catch { /* non-JSON body */ }
      // The key authenticated but lacks THIS endpoint's scope → the key is valid.
      if (/missing_permission/i.test(detail)) return { ok: true };
      // The key itself is rejected → no point probing further.
      if (/invalid_api_key|api_key_not_found|invalid/i.test(detail)) return { ok: false, error: "elevenlabs_invalid_key" };
      // 5xx is a transient ElevenLabs problem, not a bad key — surface as-is.
      if (res.status >= 500) break;
    }
    const hint = lastStatus === 401 || lastStatus === 403 ? "elevenlabs_unauthorized" : `elevenlabs_${lastStatus || "unverified"}`;
    return { ok: false, error: hint };
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

  async listVoices(): Promise<ListVoicesResult> {
    if (!this.configured()) return { voices: [], dryRun: true };
    let res: Response;
    try {
      // /v1/voices returns every voice on the account: cloned, professional,
      // library-added, and the premade set. One call, no pagination for a normal
      // account. (v2 adds search/paging; not needed for a single-account picker.)
      res = await fetch(`${this.base}/voices`, { headers: { "xi-api-key": this.key() } });
    } catch (e: any) {
      return { voices: [], dryRun: false, error: e?.message || "elevenlabs_error" };
    }
    if (!res.ok) {
      // A key scoped for text-to-speech only (no voices_read) 401s here even
      // though it synthesizes fine. Surface THAT precisely so the UI can tell the
      // operator to enable the permission, instead of a bare "no voices".
      const raw = await res.text().catch(() => "");
      const err = /voices_read|missing the permission/i.test(raw)
        ? "elevenlabs_missing_voices_read"
        : `elevenlabs_${res.status}`;
      return { voices: [], dryRun: false, error: err };
    }
    const data: any = await res.json().catch(() => ({}));
    const voices: ProviderVoice[] = (Array.isArray(data?.voices) ? data.voices : [])
      .map((v: any): ProviderVoice => ({
        voiceId: String(v?.voice_id || ""),
        name: String(v?.name || v?.voice_id || "Unnamed voice"),
        category: v?.category ? String(v.category) : undefined,
        previewUrl: v?.preview_url ? String(v.preview_url) : undefined,
      }))
      .filter((v: ProviderVoice) => v.voiceId);
    // Surface the operator's OWN voices first (cloned/professional/generated),
    // premade set last — the picker leads with what they actually made.
    const rank = (c?: string) => (c === "premade" ? 1 : 0);
    voices.sort((a, b) => rank(a.category) - rank(b.category) || a.name.localeCompare(b.name));
    return { voices, dryRun: false };
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

/**
 * Hume (Octave TTS) adapter. Synthesize by voice id against POST /v0/tts/file,
 * which returns the rendered audio bytes directly — same dry-run contract as the
 * others, and we request mp3 so it caches identically and plays straight to
 * Telnyx. The pasted voice id is resolved against HUME_VOICE_SOURCE: "CUSTOM_VOICE"
 * (a voice the operator saved to their account — the bring-your-own default) or
 * "HUME_AI" (a preset from Hume's shared Voice Library).
 */
class HumeClient implements VoiceCloneClient {
  id = "hume";
  private base = "https://api.hume.ai/v0";

  private key(): string {
    return cred("HUME_API_KEY");
  }
  configured(): boolean {
    return Boolean(this.key());
  }
  private defaultVoice(): string {
    return cred("HUME_VOICE_ID");
  }
  /** Which Hume voice pool a pasted id belongs to (custom-saved by default). */
  private voiceSource(): "CUSTOM_VOICE" | "HUME_AI" {
    return cred("HUME_VOICE_SOURCE") === "HUME_AI" ? "HUME_AI" : "CUSTOM_VOICE";
  }

  async verify(): Promise<{ ok: boolean; error?: string }> {
    if (!this.configured()) return { ok: false, error: "no_api_key" };
    try {
      // Listing the account's custom voices is a cheap authenticated read that
      // proves the key works (so we know it'll deploy, not just dry-run).
      const res = await fetch(`${this.base}/tts/voices?provider=CUSTOM_VOICE&page_number=0`, {
        headers: { "X-Hume-Api-Key": this.key() },
      });
      return res.ok ? { ok: true } : { ok: false, error: `hume_${res.status}` };
    } catch (e: any) {
      return { ok: false, error: e?.message || "hume_error" };
    }
  }

  async synthesize(text: string, voiceId?: string): Promise<SynthResult> {
    const vid = voiceId || this.defaultVoice();
    if (!this.configured() || !vid) {
      console.info(`[voice-clone:dry] hume synth "${text.slice(0, 48)}" (voice=${vid || "unset"})`);
      return { contentType: "audio/mpeg", dryRun: true };
    }
    const res = await synthRequest(`${this.base}/tts/file`, {
      method: "POST",
      headers: {
        "X-Hume-Api-Key": this.key(),
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        utterances: [{ text, voice: { id: vid, provider: this.voiceSource() } }],
        format: { type: "mp3" },
        num_generations: 1,
      }),
    });
    const audio = Buffer.from(await res.arrayBuffer());
    return { audio, contentType: "audio/mpeg", dryRun: false };
  }

  // Bring-your-own-voice only: a user pastes a Hume voice id (custom or preset).
  // Hume mints a saved voice from a prior generation_id rather than a raw sample
  // upload, so the ElevenLabs-style "clone from a recording" path is a safe no-op.
  async createVoice(): Promise<CreateVoiceResult> {
    return { dryRun: true, error: "hume_clone_unsupported" };
  }
}

const singletons: Partial<Record<VoiceProvider, VoiceCloneClient>> = {};

/** Resolve the voice-clone client for a provider (defaults to VOICE_CLONE_PROVIDER, else elevenlabs). */
export function getVoiceClientFor(provider?: VoiceProvider): VoiceCloneClient {
  const p: VoiceProvider =
    provider || ((cred("VOICE_CLONE_PROVIDER") as VoiceProvider) || "elevenlabs");
  if (!singletons[p]) {
    singletons[p] =
      p === "cartesia" ? new CartesiaClient() : p === "hume" ? new HumeClient() : new ElevenLabsClient();
  }
  return singletons[p]!;
}

/** The default voice-clone client (back-compat shim over getVoiceClientFor). */
export function getVoiceClient(): VoiceCloneClient {
  return getVoiceClientFor();
}

/** Configured-status for every provider — for the UI's "ready" checks. */
export function voiceProviderStatuses(): Array<{ id: VoiceProvider; configured: boolean }> {
  return (["elevenlabs", "cartesia", "hume"] as VoiceProvider[]).map((id) => ({
    id,
    configured: getVoiceClientFor(id).configured(),
  }));
}

/** Live key check for one provider (the "Test" button — proves it'll deploy). */
export function verifyVoiceProvider(provider?: VoiceProvider): Promise<{ ok: boolean; error?: string }> {
  return getVoiceClientFor(provider).verify();
}
