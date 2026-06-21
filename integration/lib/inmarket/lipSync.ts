/**
 * RecruitersOS · In-Market · Lip-sync provider (pluggable, self-hosted)
 *
 * The personalized intro of a role video says the recipient's name in the operator's CLONED
 * voice ("Hey Sarah,"). But the operator's MOUTH in the recording said something else, so without
 * help the lips don't match the spoken name. This module re-renders the mouth of a short face clip
 * to match the cloned-name audio — the Sendspark "lip cloning" idea, done with an OPEN-SOURCE model
 * we self-host, so there's no per-video API spend.
 *
 * It is a thin, vendor-neutral HTTP client. We DON'T bake any one model in: you run a small
 * inference microservice (Wav2Lip / MuseTalk / LatentSync — see VOICE-LIPSYNC.md) and point us at
 * it. The contract is intentionally tiny:
 *
 *   POST {LIPSYNC_URL}                       multipart/form-data
 *     field "face"   = the driving face video (mp4/webm), at least as long as the audio
 *     field "audio"  = the speech to sync to (mp3/wav)
 *     field "model"  = optional model hint (LIPSYNC_MODEL), passed through to the service
 *   -> 200 with body = the lip-synced video bytes (video/mp4)
 *   -> non-2xx (or no LIPSYNC_URL) => we return false and the caller DEGRADES GRACEFULLY to the
 *      frozen-first-frame intro (still cloned voice, just no mouth motion). Lip-sync is an
 *      enhancement, never a hard dependency.
 *
 *   LIPSYNC_URL          full URL of your inference service (unset = feature off)
 *   LIPSYNC_API_KEY      optional bearer/x-api-key sent to the service
 *   LIPSYNC_MODEL        optional model id passed through (e.g. "latentsync" | "musetalk" | "wav2lip")
 *   LIPSYNC_TIMEOUT_MS   per-request timeout (default 180000; diffusion models are slow)
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

/** True when a lip-sync microservice URL is configured. */
export function lipSyncConfigured(): boolean {
  return Boolean((process.env.LIPSYNC_URL || "").trim());
}

/** Human-readable model label for the UI / logs (purely informational). */
export function lipSyncModelLabel(): string {
  return (process.env.LIPSYNC_MODEL || "").trim() || (lipSyncConfigured() ? "custom" : "off");
}

function timeoutMs(): number {
  const n = Number(process.env.LIPSYNC_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 180_000;
}

function mimeFor(path: string): string {
  const ext = path.toLowerCase().split(".").pop() || "";
  return (
    { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4" } as Record<string, string>
  )[ext] || "application/octet-stream";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Lip-sync `faceVideoPath` to `audioPath` and write the result to `outPath`.
 * Returns true on success; false (never throws) when the service is unconfigured, errors, or times
 * out — the caller keeps the non-lip-synced intro. Retries 429/5xx a couple of times.
 */
export async function lipSyncToFile(faceVideoPath: string, audioPath: string, outPath: string): Promise<boolean> {
  const url = (process.env.LIPSYNC_URL || "").trim();
  if (!url) return false;

  let faceBuf: Buffer, audioBuf: Buffer;
  try {
    [faceBuf, audioBuf] = await Promise.all([readFile(faceVideoPath), readFile(audioPath)]);
  } catch (e) {
    console.error("[lipSync] could not read inputs:", (e as Error).message);
    return false;
  }

  const key = (process.env.LIPSYNC_API_KEY || "").trim();
  const model = (process.env.LIPSYNC_MODEL || "").trim();
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs());
    try {
      const form = new FormData();
      form.append("face", new Blob([new Uint8Array(faceBuf)], { type: mimeFor(faceVideoPath) }), basename(faceVideoPath));
      form.append("audio", new Blob([new Uint8Array(audioBuf)], { type: mimeFor(audioPath) }), basename(audioPath));
      if (model) form.append("model", model);

      const headers: Record<string, string> = {};
      if (key) { headers["Authorization"] = `Bearer ${key}`; headers["x-api-key"] = key; }

      const res = await fetch(url, { method: "POST", body: form as any, headers, signal: ctrl.signal });
      if (res.ok) {
        const out = Buffer.from(await res.arrayBuffer());
        if (!out.length) { console.error("[lipSync] empty response body"); return false; }
        await writeFile(outPath, out);
        return true;
      }
      const retryable = res.status === 429 || res.status >= 500;
      const bodyText = await res.text().catch(() => "");
      console.error(`[lipSync] ${res.status} ${bodyText.slice(0, 200)}`);
      if (!retryable || attempt === maxAttempts) return false;
      await sleep(Math.min(8000, 600 * 2 ** (attempt - 1)));
    } catch (e: any) {
      const aborted = e?.name === "AbortError";
      console.error(`[lipSync] request ${aborted ? "timed out" : "failed"}: ${e?.message || e}`);
      if (attempt === maxAttempts) return false;
      await sleep(Math.min(8000, 600 * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}
