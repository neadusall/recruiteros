/**
 * RecruitersOS · In-Market · captions for the personalized role videos.
 *
 * THE COST RULE: a transcript is bought ONCE PER RECORDING, never per personalized video.
 * Every composite is the same webcam take laid over a different page scroll, so the spoken words
 * are identical across thousands of sends. We transcribe a clip the first time anyone asks,
 * store the result under the clip id, and serve that same transcript to every video built from
 * it forever after. Re-recording is the only thing that ever costs again.
 *
 * Captions are served as WebVTT to the watch page's <track>, so they render as text under the
 * video with no re-encode: burning them into the MP4 would mean re-rendering every composite,
 * which is exactly the per-video cost this design avoids.
 */

import { loadSnapshot, saveSnapshot } from "../db";
import { cred } from "../providers/http";
import { getClip, clipFilePath } from "./roleVideo";

const CACHE_KEY = "inmarket_clip_captions_v1";
const ELEVEN_BASE = "https://api.elevenlabs.io/v1";
/** Scribe is ElevenLabs' speech-to-text model; word timings are what make real captions. */
const STT_MODEL = process.env.ELEVENLABS_STT_MODEL || "scribe_v1";

export interface CaptionWord { text: string; start: number; end: number }

export interface ClipCaptions {
  clipId: string;
  text: string;
  words: CaptionWord[];
  vtt: string;
  /** Where it came from, so the UI can be honest: transcribed once, or typed by hand. */
  source: "elevenlabs" | "manual";
  at: string;
  /** Seconds of audio billed the one time we transcribed. Zero on manual captions. */
  billedSeconds?: number;
}

type Cache = Record<string, ClipCaptions>;

async function readCache(): Promise<Cache> {
  return (await loadSnapshot<Cache>(CACHE_KEY).catch(() => null)) || {};
}

/** The cached transcript for a clip, without spending anything. */
export async function cachedCaptions(clipId: string): Promise<ClipCaptions | null> {
  if (!clipId) return null;
  return (await readCache())[clipId] || null;
}

/* ------------------------------------------------------------------ */
/* WebVTT                                                              */
/* ------------------------------------------------------------------ */

function stamp(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
}

/**
 * Group words into short cues. Two lines of a few words each is what stays readable at the
 * bottom of a video; one giant paragraph is not a caption.
 */
export function wordsToVtt(words: CaptionWord[], fullText?: string): string {
  const usable = words.filter((w) => w.text && isFinite(w.start) && isFinite(w.end));
  if (!usable.length) {
    // No timings: show the whole line for the first minute rather than nothing at all.
    const t = (fullText || "").trim();
    return t ? `WEBVTT\n\n${stamp(0)} --> ${stamp(60)}\n${t}\n` : "WEBVTT\n";
  }
  const MAX_CHARS = 74;     // roughly two comfortable lines
  const MAX_SECONDS = 5;    // a cue that lingers longer feels stuck
  const cues: { start: number; end: number; text: string }[] = [];
  let cur: { start: number; end: number; text: string } | null = null;
  for (const w of usable) {
    const word = w.text.trim();
    if (!word) continue;
    if (
      cur &&
      (cur.text.length + 1 + word.length > MAX_CHARS ||
        w.end - cur.start > MAX_SECONDS ||
        /[.!?]$/.test(cur.text))
    ) {
      cues.push(cur);
      cur = null;
    }
    if (!cur) cur = { start: w.start, end: w.end, text: word };
    else { cur.text += " " + word; cur.end = w.end; }
  }
  if (cur) cues.push(cur);

  return (
    "WEBVTT\n\n" +
    cues
      .map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(Math.max(c.end, c.start + 0.4))}\n${c.text}`)
      .join("\n\n") +
    "\n"
  );
}

/* ------------------------------------------------------------------ */
/* Transcription (once per clip, ever)                                 */
/* ------------------------------------------------------------------ */

function apiKey(): string {
  return (cred("VOICE_CLONE_API_KEY") || process.env.ELEVENLABS_API_KEY || "").trim();
}

export function captionsConfigured(): boolean {
  return !!apiKey();
}

/**
 * Transcribe one recorded clip and cache it forever. Returns the cached copy without spending
 * when we already hold one, which is the whole point: a thousand personalized videos built on
 * the same take cost exactly one transcription.
 */
export async function transcribeClip(
  clipId: string,
  opts?: { force?: boolean },
): Promise<{ ok: true; captions: ClipCaptions; cached: boolean } | { ok: false; error: string }> {
  if (!clipId) return { ok: false, error: "missing_clip" };

  const cache = await readCache();
  if (!opts?.force && cache[clipId]) return { ok: true, captions: cache[clipId], cached: true };

  const key = apiKey();
  if (!key) return { ok: false, error: "no_api_key" };

  const clip = await getClip(clipId);
  if (!clip) return { ok: false, error: "clip_not_found" };

  let bytes: Buffer;
  try {
    const { materializeClip } = await import("./roleVideo");
    await materializeClip(clip);            // pull back from S3 if the local copy was evicted
    const { readFile } = await import("node:fs/promises");
    bytes = await readFile(clipFilePath(clip));
  } catch {
    return { ok: false, error: "clip_unreadable" };
  }

  let body: any;
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: clip.mime || "video/webm" }), `${clipId}.${clip.ext || "webm"}`);
    form.append("model_id", STT_MODEL);
    const res = await fetch(`${ELEVEN_BASE}/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": key },
      body: form,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      return { ok: false, error: `elevenlabs_${res.status}${detail ? `: ${detail}` : ""}` };
    }
    body = await res.json();
  } catch (e: any) {
    return { ok: false, error: e?.message || "transcribe_failed" };
  }

  // Word timings live under `words` on Scribe responses; tolerate a plain-text-only reply.
  const rawWords: any[] = Array.isArray(body?.words) ? body.words : [];
  const words: CaptionWord[] = rawWords
    .filter((w) => w && (w.type ? w.type === "word" : true) && typeof w.text === "string")
    .map((w) => ({ text: String(w.text), start: Number(w.start ?? 0), end: Number(w.end ?? w.start ?? 0) }));
  const text = String(body?.text || words.map((w) => w.text).join(" ")).trim();
  if (!text) return { ok: false, error: "empty_transcript" };

  const captions: ClipCaptions = {
    clipId,
    text,
    words,
    vtt: wordsToVtt(words, text),
    source: "elevenlabs",
    at: new Date().toISOString(),
    billedSeconds: words.length ? Math.round(words[words.length - 1].end) : 0,
  };
  cache[clipId] = captions;
  await saveSnapshot(CACHE_KEY, cache);
  return { ok: true, captions, cached: false };
}

/** Hand-write or correct a clip's captions. Costs nothing and wins over the machine transcript. */
export async function setManualCaptions(clipId: string, text: string, durationSec = 60): Promise<ClipCaptions | null> {
  const t = (text || "").trim();
  if (!clipId || !t) return null;
  const cache = await readCache();
  // Spread the typed line evenly so the words still track the speech instead of sitting still.
  const parts = t.split(/\s+/);
  const per = parts.length ? durationSec / parts.length : 0;
  const words: CaptionWord[] = parts.map((w, i) => ({ text: w, start: i * per, end: (i + 1) * per }));
  const captions: ClipCaptions = {
    clipId, text: t, words, vtt: wordsToVtt(words, t), source: "manual", at: new Date().toISOString(), billedSeconds: 0,
  };
  cache[clipId] = captions;
  await saveSnapshot(CACHE_KEY, cache);
  return captions;
}

/* ------------------------------------------------------------------ */
/* videoKey -> which recording                                         */
/* ------------------------------------------------------------------ */

/**
 * Which recording a finished video was built from. Composites record their clip id going
 * forward; for videos rendered before that, a workspace with a single recording can only have
 * used that one.
 */
export async function clipIdForVideo(videoKey: string, workspaceId?: string): Promise<string | null> {
  if (!videoKey) return null;
  try {
    const { getVideoRecord } = await import("./roleVideo");
    const rec = await getVideoRecord(videoKey);
    if (rec?.clipId) return rec.clipId;
  } catch { /* fall through to the single-clip case */ }
  if (workspaceId) {
    try {
      const { listClips } = await import("./roleVideo");
      const clips = await listClips(workspaceId);
      if (clips.length === 1) return clips[0].id;
    } catch { /* no clips listed */ }
  }
  return null;
}

/** The WebVTT a watch page should show for a video, or null when we have no transcript yet. */
export async function captionsForVideo(videoKey: string, workspaceId?: string): Promise<string | null> {
  const clipId = await clipIdForVideo(videoKey, workspaceId);
  if (!clipId) return null;
  const c = await cachedCaptions(clipId);
  return c?.vtt || null;
}
