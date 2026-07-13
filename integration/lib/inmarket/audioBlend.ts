/**
 * RecruitersOS · In-Market · Intro/body audio blending (the "you can't tell" step)
 *
 * The cloned-voice "Hey {name}," comes out of ElevenLabs studio-clean: full-bandwidth, loud,
 * dead-silent floor. The operator's recorded body take is a webcam mic: quieter, band-limited,
 * with real room tone. Butt-splicing the two is exactly what makes personalized intros sound
 * pasted-on. Before the intro is spliced, we re-master it TO the recording:
 *
 *   1. trim the TTS lead-in/tail silence (keeps the greeting tight on the cut),
 *   2. measure both sides' integrated loudness (ffmpeg loudnorm analysis) and gain-match the
 *      intro to the BODY's level — the single biggest tell,
 *   3. roll the studio sheen off into webcam bandwidth (gentle high/low-pass), the second tell,
 *   4. leave a short natural beat after the name so "Hey Sarah," breathes into the real take,
 *      with a micro fade-in so the edit can never click.
 *
 * Everything is plain ffmpeg (already a hard dep of the video pipeline; no paid API). Every
 * function degrades to null so a blend failure NEVER blocks a render — the caller just splices
 * the unblended intro like before.
 */

import { spawn } from "node:child_process";

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

/** Run ffmpeg capturing stderr (loudnorm prints its analysis there). Rejects on non-zero exit. */
function runFfmpegCapture(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(ffmpegBin(), args, { windowsHide: true });
    } catch (e) {
      return reject(new Error(`ffmpeg spawn failed: ${(e as Error).message}`));
    }
    let err = "";
    proc.stderr?.on("data", (d) => { err += d.toString(); if (err.length > 32000) err = err.slice(-32000); });
    proc.on("error", (e: any) => reject(e?.code === "ENOENT" ? new Error("ffmpeg_not_found") : e));
    proc.on("close", (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg exited ${code}: ${err.trim().split("\n").slice(-4).join(" | ")}`))));
  });
}

export interface LoudnessStats {
  /** Integrated loudness, LUFS (loudnorm input_i). */
  i: number;
  /** True peak, dBTP (loudnorm input_tp). */
  tp: number;
}

/**
 * Measure a file's integrated loudness via a loudnorm analysis pass (audio only, no output).
 * Works on any container ffmpeg can read — the webcam clip, the TTS mp3, an mp4 composite.
 * Returns null when the file has no measurable audio (silent clip, no track).
 */
export async function measureLoudness(file: string): Promise<LoudnessStats | null> {
  let out: string;
  try {
    out = await runFfmpegCapture([
      "-hide_banner", "-nostats", "-i", file,
      "-vn", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
      "-f", "null", "-",
    ]);
  } catch {
    return null;
  }
  // loudnorm prints one JSON block at the end of stderr.
  const m = out.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/g);
  if (!m || !m.length) return null;
  try {
    const j = JSON.parse(m[m.length - 1]);
    const i = parseFloat(j.input_i);
    const tp = parseFloat(j.input_tp);
    // loudnorm reports -inf for silence; treat anything absurdly low as unmeasurable.
    if (!Number.isFinite(i) || i < -60) return null;
    return { i, tp: Number.isFinite(tp) ? tp : -1.5 };
  } catch {
    return null;
  }
}

const clampDb = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Re-master the cloned-voice intro so it sits in the SAME sonic space as the body recording,
 * writing a wav (one lossless intermediate — it gets AAC-encoded once, at the final splice).
 *
 * Returns outPath on success, null on ANY failure (caller splices the raw intro instead).
 */
export async function blendIntroToBody(
  introPath: string, bodyPath: string, outPath: string,
): Promise<string | null> {
  const [body, intro] = await Promise.all([measureLoudness(bodyPath), measureLoudness(introPath)]);
  if (!intro) return null;

  // Gain-match the intro to the body's integrated loudness. When the body is unmeasurable
  // (rare: near-silent take), aim at a conservative -19 LUFS instead of matching noise.
  const targetI = body ? body.i : -19;
  const gainDb = clampDb(targetI - intro.i, -18, 12);
  // Never let the gained intro clip: cap the gain so true peak stays under -1 dBTP.
  const headroom = -1 - (intro.tp + gainDb);
  const finalGain = headroom < 0 ? gainDb + headroom : gainDb;

  const filters = [
    // Tight trim: cut the TTS lead-in silence, then (via double reverse) the tail — but keep the
    // last ~120ms of natural decay so the comma still "lands" instead of being chopped.
    "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03",
    "areverse",
    "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.12",
    "areverse",
    // Loudness match (the #1 seam tell).
    `volume=${finalGain.toFixed(2)}dB`,
    // Sit the studio voice in webcam-mic bandwidth (the #2 tell): soften the sub-rumble the
    // webcam never captures and roll the airy top back so it doesn't sparkle over the body take.
    "highpass=f=90",
    "lowpass=f=11000",
    // Micro fade-in so the hard edit at t=0 can never click.
    "afade=t=in:st=0:d=0.015",
    // A short natural beat after "…{name}," before the real take starts talking.
    "apad=pad_dur=0.22",
    // One canonical format for the splice graph (matches the composite's 44.1k).
    "aresample=44100",
  ].join(",");

  try {
    await runFfmpegCapture([
      "-y", "-hide_banner", "-nostats", "-i", introPath,
      "-vn", "-af", filters, "-ac", "2", "-c:a", "pcm_s16le", outPath,
    ]);
    return outPath;
  } catch (e) {
    console.error("[audioBlend] intro blend failed:", (e as Error).message);
    return null;
  }
}
