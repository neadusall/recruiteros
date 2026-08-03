/**
 * RecruitersOS · Phone · Voicemail greetings
 *
 * Storage for the per-line voicemail greeting a recruiter records in the
 * browser (BD Phone tab). The audio arrives as a small WAV the client encoded
 * from the microphone; it is written to the durable data volume (same
 * resolution rules as lib/db: ROS_DATA_DIR, else /data in production) so
 * greetings survive every redeploy. Telnyx fetches the greeting through the
 * public /api/phone/voicemail/audio/{file} route during playback_start; file
 * names are opaque (line id + random suffix) and never enumerable.
 */

import { promises as fs } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

/** Greetings a recruiter would realistically record are seconds long; a WAV
 *  above this is a client bug, not a greeting. */
export const MAX_GREETING_BYTES = 6 * 1024 * 1024;
export const MAX_GREETING_SECONDS = 90;

function greetingDir(): string {
  if (process.env.PHONE_VOICEMAIL_DIR) return process.env.PHONE_VOICEMAIL_DIR;
  const base =
    process.env.ROS_DATA_DIR ??
    (process.env.NODE_ENV === "production" ? "/data" : join(process.cwd(), ".data"));
  return join(base, "voicemail-greetings");
}

function appUrl(): string {
  return process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co";
}

/** Public URL Telnyx's media fetcher can reach for a stored greeting. */
export function greetingUrl(file: string): string {
  return `${appUrl()}/api/phone/voicemail/audio/${encodeURIComponent(file)}`;
}

/** Only names this module generated are ever readable: no separators, no
 *  traversal, one flat directory. */
function safeName(file: string): string | null {
  return /^vm_[a-zA-Z0-9_-]+\.wav$/.test(file) ? file : null;
}

/** Persist a new greeting for a line; returns the opaque file name. */
export async function writeGreeting(lineId: string, wav: Buffer): Promise<string> {
  const file = `vm_${lineId.replace(/[^a-zA-Z0-9_-]/g, "")}_${randomBytes(6).toString("hex")}.wav`;
  await fs.mkdir(greetingDir(), { recursive: true });
  await fs.writeFile(join(greetingDir(), file), wav);
  return file;
}

export async function readGreeting(file: string): Promise<Buffer | null> {
  const name = safeName(file);
  if (!name) return null;
  try {
    return await fs.readFile(join(greetingDir(), name));
  } catch {
    return null;
  }
}

/** Remove a greeting's audio (replaced or deleted). Best-effort. */
export async function deleteGreeting(file: string): Promise<void> {
  const name = safeName(file);
  if (!name) return;
  await fs.unlink(join(greetingDir(), name)).catch(() => {});
}

/** A syntactically valid RIFF/WAVE container (what the client encoder emits). */
export function looksLikeWav(buf: Buffer): boolean {
  return buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE";
}
