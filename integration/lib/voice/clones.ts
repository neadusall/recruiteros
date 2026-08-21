/**
 * RecruitersOS · Voice Drops · Clone snippet cache (the token-saver)
 *
 * The cost trick: a voicemail is assembled from cacheable audio SEGMENTS, not
 * re-synthesized whole every time. Static prose (intro/middle/outro) renders
 * ONCE per script+voice; the variable words ({first_name}, {role}, {company})
 * render once PER UNIQUE VALUE and are reused forever after. So the first time we
 * say "Hector" or "VP of Sales" we spend one synthesis; every later lead with
 * that name/role reuses the cached audio at zero cost.
 *
 * Each segment's audio is keyed by (voiceId + normalized text) and persisted to
 * the file volume, so the repository of cloned first names / roles survives
 * restarts (matches the deploy's file-volume persistence). A manifest maps key
 * -> file. Cache hits never touch the provider and never bill.
 *
 * Audio is served back to Telnyx via GET /api/voice/audio/{file} (a public URL
 * playback_start can fetch). Assembly returns an ORDERED PLAYLIST of segment
 * URLs; the voice webhook plays them in sequence onto the voicemail.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { cacheKey, type ScriptSegment } from "./script";
import { getVoiceClientFor, voiceSettingsTag, type VoiceProvider } from "./provider";

/**
 * Which voice to synthesize in: a provider + that provider's voice id. Either may
 * be omitted — synthesize falls back to the provider's configured default voice,
 * and an omitted provider falls back to VOICE_CLONE_PROVIDER.
 */
export interface VoiceRef {
  provider?: VoiceProvider;
  voiceId?: string;
}

/** Stable cache namespace for a voice so two providers never collide on an id.
 *  Includes a settings tag so re-tuning the voice (stability/similarity/etc.)
 *  produces fresh audio instead of replaying the old take from cache. */
function voiceKey(voice: VoiceRef): string {
  return `${voice.provider || "el"}_${voice.voiceId || "default"}_${voiceSettingsTag(voice.provider)}`;
}

/**
 * Where rendered clone segments and uploaded pitch recordings live.
 *
 * MUST resolve onto the persistent data volume, not the container filesystem.
 * Until 2026-08-21 this fell back to `process.cwd()/.data`, which inside the
 * production image is `/app/integration/.data` — a container layer. Every deploy
 * (the watcher rebuilds on each new commit) therefore threw away the whole clone
 * archive AND every recruiter's uploaded pitch recording: the cache re-billed
 * ElevenLabs from zero, and a campaign in `recording` mode failed its leads on a
 * file that no longer existed. Same resolution rules as lib/db and
 * lib/phone/voicemail.ts (ROS_DATA_DIR, else /data in production).
 */
function cacheDir(): string {
  if (process.env.VOICE_CLONE_CACHE_DIR) return process.env.VOICE_CLONE_CACHE_DIR;
  const base =
    process.env.ROS_DATA_DIR ??
    (process.env.NODE_ENV === "production" ? "/data" : join(process.cwd(), ".data"));
  return join(base, "voice-clones");
}

/** The resolved cache directory, for health checks that assert durability. */
export function voiceCacheDir(): string {
  return cacheDir();
}

function appUrl(): string {
  return process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co";
}

/** Disk-safe file name for a (voice, key) pair. */
function fileFor(voiceId: string | undefined, key: string): string {
  const v = (voiceId || "default").replace(/[^a-z0-9_-]+/gi, "_");
  const k = key.replace(/[^a-z0-9_.:-]+/gi, "_").replace(/:/g, "__");
  return `${v}__${k}.mp3`;
}

/** Public URL Telnyx can fetch for a cached segment. */
export function audioUrl(file: string): string {
  return `${appUrl()}/api/voice/audio/${encodeURIComponent(file)}`;
}

/* ---------------- manifest (which keys are already rendered) ---------------- */

interface Manifest {
  /** file -> { key, voiceId, bytes, createdAt } */
  entries: Record<string, { key: string; voiceId: string; bytes: number; createdAt: string }>;
}

let manifest: Manifest | null = null;

async function loadManifest(): Promise<Manifest> {
  if (manifest) return manifest;
  try {
    const raw = await fs.readFile(join(cacheDir(), "manifest.json"), "utf8");
    manifest = JSON.parse(raw);
  } catch {
    manifest = { entries: {} };
  }
  return manifest!;
}

async function saveManifest(): Promise<void> {
  if (!manifest) return;
  await fs.mkdir(cacheDir(), { recursive: true });
  await fs.writeFile(join(cacheDir(), "manifest.json"), JSON.stringify(manifest), "utf8");
}

/** Read a cached segment's bytes for the audio-serving route. */
export async function readSegment(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(join(cacheDir(), file));
  } catch {
    return null;
  }
}

/** Snapshot of the cached repository for the UI (names/roles already cloned). */
export async function cacheStats(): Promise<{
  total: number; byKind: Record<string, number>; bytes: number;
}> {
  const m = await loadManifest();
  const byKind: Record<string, number> = {};
  let bytes = 0;
  for (const e of Object.values(m.entries)) {
    const kind = e.key.split(":")[0] || "other";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    bytes += e.bytes;
  }
  return { total: Object.keys(m.entries).length, byKind, bytes };
}

/* ---------------- pre-recorded pitch audio (uploaded, not synthesized) ------
   Recordings live in the SAME cache volume + manifest as clone segments, so the
   existing public serve route (/api/voice/audio/{file}), file-volume durability,
   and cache stats all just work. Keyed "recording:<id>"; never re-synthesized. */

/** Persist an uploaded/mic-recorded pitch; returns the servable file name. */
export async function saveRecordingAudio(id: string, bytes: Buffer, ext: "mp3" | "wav"): Promise<string> {
  const m = await loadManifest();
  const file = `rec_${id.replace(/[^a-z0-9_-]+/gi, "_")}.${ext}`;
  await fs.mkdir(cacheDir(), { recursive: true });
  await fs.writeFile(join(cacheDir(), file), bytes);
  m.entries[file] = { key: `recording:${id}`, voiceId: "recording", bytes: bytes.length, createdAt: new Date().toISOString() };
  await saveManifest();
  return file;
}

/* ---------------- enrollment takes (the raw voice samples) -----------------
   A recruiter's enrollment reads live in the SAME durable cache volume as clone
   segments, so they inherit the public serve route, the file-volume persistence
   and the cache accounting. They are the evidence behind a cloned voice — the
   recorded consent statement is one of them — so they are kept after cloning,
   not discarded, and only removed when the recruiter re-records or resets. */

/** Persist one enrollment take; returns the servable file name. */
export async function saveEnrollmentAudio(id: string, bytes: Buffer, ext: "mp3" | "wav"): Promise<string> {
  const m = await loadManifest();
  const file = `enr_${id.replace(/[^a-z0-9_-]+/gi, "_")}.${ext}`;
  await fs.mkdir(cacheDir(), { recursive: true });
  await fs.writeFile(join(cacheDir(), file), bytes);
  m.entries[file] = { key: `enrollment:${id}`, voiceId: "enrollment", bytes: bytes.length, createdAt: new Date().toISOString() };
  await saveManifest();
  return file;
}

/** Read one enrollment take back, to post it to the cloner. */
export async function readEnrollmentAudio(file: string): Promise<Buffer | null> {
  return readSegment(file);
}

/** Delete an enrollment take's audio + manifest entry (best-effort on the file). */
export async function deleteEnrollmentAudio(file: string): Promise<void> {
  const m = await loadManifest();
  delete m.entries[file];
  await saveManifest();
  await fs.unlink(join(cacheDir(), file)).catch(() => {});
}

/** Persist a rendered "hear yourself" preview for a freshly cloned voice. */
export async function savePreviewAudio(id: string, bytes: Buffer): Promise<string> {
  const m = await loadManifest();
  const file = `prev_${id.replace(/[^a-z0-9_-]+/gi, "_")}.mp3`;
  await fs.mkdir(cacheDir(), { recursive: true });
  await fs.writeFile(join(cacheDir(), file), bytes);
  m.entries[file] = { key: `preview:${id}`, voiceId: "preview", bytes: bytes.length, createdAt: new Date().toISOString() };
  await saveManifest();
  return file;
}

/** Delete a recording's audio + manifest entry (best-effort on the file). */
export async function deleteRecordingAudio(file: string): Promise<void> {
  const m = await loadManifest();
  delete m.entries[file];
  await saveManifest();
  await fs.unlink(join(cacheDir(), file)).catch(() => {});
}

export interface RenderedSegment {
  key: string;
  url: string;
  /** True when reused from cache (no synthesis, no cost). */
  cached: boolean;
  /** True when a real synthesis ran (a billable cache miss). */
  synthesized: boolean;
  dryRun: boolean;
}

/**
 * Return the audio URL for one segment, rendering+caching it on a miss. Cache
 * hits are free; only misses call the provider (and only those are billed).
 */
export async function renderSegment(
  seg: ScriptSegment,
  voice: VoiceRef,
): Promise<RenderedSegment> {
  const m = await loadManifest();
  const file = fileFor(voiceKey(voice), seg.key);

  if (m.entries[file]) {
    return { key: seg.key, url: audioUrl(file), cached: true, synthesized: false, dryRun: false };
  }

  const client = getVoiceClientFor(voice.provider);
  const out = await client.synthesize(seg.text, voice.voiceId, {
    previousText: seg.prev,
    nextText: seg.next,
  });
  if (out.dryRun || !out.audio) {
    // No audio in dry-run; still hand back a URL so the playlist is complete and
    // the engine runs end to end. Not cached (nothing was rendered).
    return { key: seg.key, url: audioUrl(file), cached: false, synthesized: false, dryRun: true };
  }

  await fs.mkdir(cacheDir(), { recursive: true });
  await fs.writeFile(join(cacheDir(), file), out.audio);
  m.entries[file] = { key: seg.key, voiceId: voiceKey(voice), bytes: out.audio.length, createdAt: new Date().toISOString() };
  await saveManifest();

  return { key: seg.key, url: audioUrl(file), cached: false, synthesized: true, dryRun: false };
}

export interface AssembledDrop {
  /** Ordered audio URLs the webhook plays onto the voicemail, in sequence. */
  playlist: string[];
  /** Cache misses this assembly rendered (the only billable synthesis). */
  synthesized: number;
  /** Segments served from cache (free). */
  cached: number;
  dryRun: boolean;
}

/**
 * Assemble a voicemail from its segments: render/reuse each, return the ordered
 * playlist plus how many were freshly synthesized (for billing). Identical names
 * / roles / static prose are only ever synthesized once across all leads.
 */
export async function assembleDrop(
  segments: ScriptSegment[],
  voice: VoiceRef,
): Promise<AssembledDrop> {
  // Render segments ONE AT A TIME, not Promise.all. TTS/clone vendors rate-limit
  // by concurrency, so firing every segment at once is the #1 cause of a 429 that
  // would fail the whole drop. A voicemail is only a handful of segments, and
  // cache hits are instant, so serial is plenty fast and far more stable.
  const rendered: RenderedSegment[] = [];
  for (const s of segments) {
    rendered.push(await renderSegment(s, voice));
  }
  return {
    playlist: rendered.map((r) => r.url),
    synthesized: rendered.filter((r) => r.synthesized).length,
    cached: rendered.filter((r) => r.cached).length,
    dryRun: rendered.some((r) => r.dryRun),
  };
}

/**
 * CREDIT-SAVER assembly: render each splice segment (static prose + the tiny
 * name/title/company clips, all cache-aware), then CONCATENATE the audio bytes
 * into ONE mp3 and return a single-URL playlist. The webhook then plays one file,
 * so there is no dead air between pieces (the reason the plain path renders whole
 * messages), while only NEW names/titles/static ever cost a synthesis.
 *
 * mp3 byte-concatenation is safe here: every clip comes from the same voice +
 * encoder settings, so the frames play back as one file (the same trick the
 * "Download voicemail" button uses). The concatenated file is itself cached by the
 * ordered segment keys, so an identical (name + title + script) combo reuses it.
 */
export async function assembleSplicedDrop(
  segments: ScriptSegment[],
  voice: VoiceRef,
): Promise<AssembledDrop> {
  const rendered: RenderedSegment[] = [];
  for (const s of segments) rendered.push(await renderSegment(s, voice));
  const synthesized = rendered.filter((r) => r.synthesized).length;
  const cached = rendered.filter((r) => r.cached).length;

  // Dry-run (provider unconfigured): nothing was rendered, so there is nothing to
  // stitch — hand back the per-segment URLs so the flow still runs end to end.
  if (rendered.some((r) => r.dryRun)) {
    return { playlist: rendered.map((r) => r.url), synthesized, cached, dryRun: true };
  }
  if (!segments.length) return { playlist: [], synthesized, cached, dryRun: false };

  const combo = fileFor(voiceKey(voice), cacheKey("vm-spliced", segments.map((s) => s.key).join("|")));
  const m = await loadManifest();
  if (!m.entries[combo]) {
    const parts: Buffer[] = [];
    for (const s of segments) {
      const buf = await readSegment(fileFor(voiceKey(voice), s.key));
      if (buf) parts.push(buf);
    }
    const joined = Buffer.concat(parts);
    await fs.mkdir(cacheDir(), { recursive: true });
    await fs.writeFile(join(cacheDir(), combo), joined);
    m.entries[combo] = { key: `vm-spliced:${segments.length}`, voiceId: voiceKey(voice), bytes: joined.length, createdAt: new Date().toISOString() };
    await saveManifest();
  }
  return { playlist: [audioUrl(combo)], synthesized, cached, dryRun: false };
}

/** Archive rollup for the credit-saver UI: how many name/title/company clips and
 *  static phrases are cached, so the operator can see the reusable library grow. */
export async function voiceArchiveStats(): Promise<{
  firstNames: number; roles: number; companies: number; staticPhrases: number; totalClips: number; bytes: number;
}> {
  const m = await loadManifest();
  let firstNames = 0, roles = 0, companies = 0, staticPhrases = 0, bytes = 0;
  for (const e of Object.values(m.entries)) {
    bytes += e.bytes;
    const kind = e.key.split(":")[0];
    if (kind === "first_name") firstNames++;
    else if (kind === "role") roles++;
    else if (kind === "company") companies++;
    else if (kind === "static") staticPhrases++;
  }
  return { firstNames, roles, companies, staticPhrases, totalClips: Object.keys(m.entries).length, bytes };
}
