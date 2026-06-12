/**
 * RecruiterOS · Voice Drops · Clone snippet cache (the token-saver)
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
import type { ScriptSegment } from "./script";
import { getVoiceClientFor, type VoiceProvider } from "./provider";

/**
 * Which voice to synthesize in: a provider + that provider's voice id. Either may
 * be omitted — synthesize falls back to the provider's configured default voice,
 * and an omitted provider falls back to VOICE_CLONE_PROVIDER.
 */
export interface VoiceRef {
  provider?: VoiceProvider;
  voiceId?: string;
}

/** Stable cache namespace for a voice so two providers never collide on an id. */
function voiceKey(voice: VoiceRef): string {
  return `${voice.provider || "el"}_${voice.voiceId || "default"}`;
}

function cacheDir(): string {
  return process.env.VOICE_CLONE_CACHE_DIR || join(process.cwd(), ".data", "voice-clones");
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
  const out = await client.synthesize(seg.text, voice.voiceId);
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
  const rendered = await Promise.all(segments.map((s) => renderSegment(s, voice)));
  return {
    playlist: rendered.map((r) => r.url),
    synthesized: rendered.filter((r) => r.synthesized).length,
    cached: rendered.filter((r) => r.cached).length,
    dryRun: rendered.some((r) => r.dryRun),
  };
}
