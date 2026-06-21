/**
 * RecruitersOS · In-Market · Clone the operator's OWN voice from their recorded clip
 *
 * Sendspark's trick is that the personalized name is spoken in the SENDER'S real voice, cloned
 * from the recording itself (no separate upload). We do the same: take the webcam clip the operator
 * already recorded for their role videos, pull the audio out of it, and mint an ElevenLabs Instant
 * Voice Clone. We store ONE voice id per workspace and reuse it for every "Hey {name}," forever.
 *
 * IVC is the right tool here (a clone from a short ~15-60s sample, ready in seconds); Professional
 * Voice Cloning needs 30+ minutes of audio and is overkill for a greeting. See VOICE-LIPSYNC.md.
 *
 * Cost: minting an IVC voice itself is free; only the per-name TTS bills, and that's cached once per
 * (voice, name) in nameAudio.ts. Everything degrades gracefully: no API key / dry-run => no clone,
 * and the video pipeline falls back to the configured default voice (or no spoken name at all).
 *
 *   VOICE_CLONE_API_KEY   ElevenLabs key (shared with lib/voice/provider)
 *   VOICE_CLONE_VOICE_ID  fallback voice id when a workspace hasn't cloned its own
 */

import { join } from "node:path";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { readClipBytes } from "./roleVideo";
import { getVoiceClient } from "../voice/provider";
import { defaultVoiceId } from "./nameAudio";
import { loadSnapshot, debouncedSaver } from "../db";

const VOICES_CACHE_KEY = "inmarket_voices_v1";

/** A workspace's cloned voice (the "you" that speaks each recipient's name). */
export interface StoredVoice {
  workspaceId: string;
  voiceId: string;
  provider: string;
  /** The clip we cloned from (so the UI can show "cloned from your latest recording"). */
  clipId?: string;
  name?: string;
  at: string;
}

/* ---------------- durable per-workspace store ---------------- */

let mem: Map<string, StoredVoice> | null = null;
let loading: Promise<void> | null = null;

async function ensure(): Promise<Map<string, StoredVoice>> {
  if (mem) return mem;
  if (!loading) {
    loading = (async () => {
      const raw = (await loadSnapshot<Record<string, StoredVoice>>(VOICES_CACHE_KEY).catch(() => null)) || {};
      mem = new Map(Object.entries(raw));
    })().catch(() => { mem = new Map(); });
  }
  await loading;
  return mem ?? (mem = new Map());
}
const save = debouncedSaver(VOICES_CACHE_KEY, () => (mem ? Object.fromEntries(mem) : {}), 1000);

/** The voice a workspace has cloned for itself, if any. */
export async function getWorkspaceVoice(workspaceId: string): Promise<StoredVoice | null> {
  const m = await ensure();
  return m.get(workspaceId) ?? null;
}

/**
 * Resolve the voice id to speak a name in, for this workspace:
 *   explicit override  ->  workspace's own clone  ->  env default (VOICE_CLONE_VOICE_ID).
 * Returns undefined when nothing is configured (caller skips the spoken name).
 */
export async function resolveVoiceId(workspaceId: string, explicit?: string | null): Promise<string | undefined> {
  const ex = (explicit || "").trim();
  if (ex) return ex;
  const own = await getWorkspaceVoice(workspaceId);
  if (own?.voiceId) return own.voiceId;
  const def = defaultVoiceId();
  return def || undefined;
}

/* ---------------- ffmpeg audio extraction ---------------- */

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

/** Extract a clean mono mp3 from a clip buffer (ElevenLabs cloning likes clean speech-only audio). */
async function extractAudioMp3(clipBuf: Buffer, ext: string): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), "ros-voice-"));
  const inPath = join(dir, `in.${ext || "webm"}`);
  const outPath = join(dir, "out.mp3");
  try {
    await writeFile(inPath, clipBuf);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        ffmpegBin(),
        ["-y", "-hide_banner", "-loglevel", "error", "-i", inPath, "-vn", "-ac", "1", "-ar", "44100", "-b:a", "128k", outPath],
        { windowsHide: true },
      );
      let err = "";
      p.stderr?.on("data", (d) => { err += d.toString(); });
      p.on("error", (e: any) => reject(e?.code === "ENOENT" ? new Error("ffmpeg_not_found") : e));
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(-300)}`))));
    });
    return await readFile(outPath);
  } catch (e) {
    console.error("[voiceClone] audio extract failed:", (e as Error).message);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ---------------- clone ---------------- */

export type CloneStatus = "ready" | "no_clip" | "no_audio" | "not_configured" | "dry_run" | "error";

export interface CloneResult {
  ok: boolean;
  status: CloneStatus;
  voiceId?: string;
  provider?: string;
  error?: string;
}

/**
 * Mint (or re-mint) this workspace's cloned voice from one of its recorded clips. Idempotent-ish:
 * pass force to re-clone (e.g. after a better recording). Records a zero-cost usage event so the
 * owner console shows the clone happened (IVC minting itself doesn't bill).
 */
export async function cloneVoiceFromClip(
  workspaceId: string,
  clipId: string,
  opts: { name?: string; force?: boolean; motion?: "recruiting" | "bd" } = {},
): Promise<CloneResult> {
  const client = getVoiceClient();
  if (!client.configured()) return { ok: false, status: "not_configured", error: "no_voice_api_key" };

  if (!opts.force) {
    const existing = await getWorkspaceVoice(workspaceId);
    if (existing?.voiceId) return { ok: true, status: "ready", voiceId: existing.voiceId, provider: existing.provider };
  }

  const got = await readClipBytes(clipId);
  if (!got) return { ok: false, status: "no_clip", error: "clip not found" };

  const ext = (got.mime.split("/")[1] || "webm").split(";")[0];
  const sample = await extractAudioMp3(got.buf, ext);
  if (!sample || sample.length < 2000) return { ok: false, status: "no_audio", error: "clip has no usable audio" };

  let res;
  try {
    res = await client.createVoice({
      name: (opts.name || `RecruitersOS ${workspaceId.slice(0, 8)}`).slice(0, 60),
      sample,
      contentType: "audio/mpeg",
    });
  } catch (e: any) {
    return { ok: false, status: "error", error: e?.message || "clone_failed" };
  }
  if (res.dryRun) return { ok: false, status: "dry_run", error: "voice provider in dry-run (no api key)" };
  if (!res.voiceId) return { ok: false, status: "error", error: res.error || "no_voice_id_returned" };

  const m = await ensure();
  const stored: StoredVoice = {
    workspaceId, voiceId: res.voiceId, provider: client.id, clipId, name: opts.name, at: new Date().toISOString(),
  };
  m.set(workspaceId, stored);
  save();

  // Best-effort: log the clone in the cost ledger (free, but visible in the owner console).
  try {
    const { recordUsage } = await import("../billing/ledger");
    recordUsage({
      workspaceId, motion: opts.motion === "bd" ? "bd" : "recruiting",
      category: "other", type: "voice_clone", source: client.id, quantity: 1, unitCostUsd: 0,
      meta: { voiceId: res.voiceId, clipId },
    });
  } catch { /* ledger optional */ }

  return { ok: true, status: "ready", voiceId: res.voiceId, provider: client.id };
}

/** Forget a workspace's cloned voice (e.g. to re-clone from a fresh recording). */
export async function forgetWorkspaceVoice(workspaceId: string): Promise<boolean> {
  const m = await ensure();
  const had = m.delete(workspaceId);
  if (had) save();
  return had;
}
