/**
 * RecruitersOS · In-Market · Cloned-voice "Hey {firstName}," intro audio
 *
 * Generates a SHORT spoken-name intro in the operator's cloned voice, to prepend to a PiP role
 * video so the recipient hears an audible "Hey Sarah," — the Sendspark/Loom personalized-intro
 * pattern. Reuses the existing voice-clone provider (lib/voice/provider — ElevenLabs by default).
 *
 * At scale: cached on disk by (voiceId, normalized name) so "Hey Sarah" is synthesized ONCE and
 * reused for every Sarah, forever — names repeat heavily, so ~all sends are free + instant. The
 * spoken text is tiny (~10 chars ≈ a fraction of a cent). Returns null (caller degrades to the
 * non-personalized video) when there's no usable name or no voice configured.
 */

import { join } from "node:path";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { videosDir } from "./roleVideo";
import { getVoiceClient } from "../voice/provider";
import { cred } from "../providers/http";

function namesDir(): string {
  return join(videosDir(), "names");
}

/** The cloned voice to speak the name. RECRUITEROS_INTRO_VOICE_ID overrides the voicedrop default.
 *  Resolved through cred() so a voice id saved in the Connected portal (per-workspace) wins over env. */
export function defaultVoiceId(): string {
  return (cred("RECRUITEROS_INTRO_VOICE_ID") || cred("VOICE_CLONE_VOICE_ID")).trim();
}

/**
 * Normalize a recipient first name for a spoken intro. Returns null when it isn't safe to say
 * (blank, an unrendered {{merge}} tag, or junk) — so we never send "Hey FIRSTNAME".
 */
export function cleanFirstName(raw?: string | null): string | null {
  let s = (raw || "").trim();
  if (!s || /\{\{|\}\}/.test(s)) return null;        // empty or unrendered merge field
  s = s.split(/\s+/)[0];                              // first token only
  s = s.replace(/[^A-Za-z'’\-]/g, "");               // drop emojis/digits/punctuation
  if (s.length < 2 || s.length > 20) return null;
  if (s.length > 3 && s === s.toUpperCase()) s = s.toLowerCase(); // de-shout ALLCAPS
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function cacheName(voiceId: string, name: string): string {
  return createHash("sha1").update(`${voiceId}|${name.toLowerCase()}`).digest("hex").slice(0, 16);
}

/**
 * Path to a cached cloned-voice "Hey {firstName}," mp3, generating it on first use. Returns null
 * when there's no usable name or the voice clone isn't configured (no API key / dry-run).
 */
export async function nameIntroAudio(rawName?: string | null, voiceId?: string): Promise<string | null> {
  const name = cleanFirstName(rawName);
  if (!name) return null;
  const client = getVoiceClient();
  if (!client.configured()) return null;
  const vid = (voiceId || defaultVoiceId()).trim();

  await mkdir(namesDir(), { recursive: true });
  const path = join(namesDir(), `${cacheName(vid || "default", name)}.mp3`);
  try { await stat(path); return path; } catch { /* cache miss → synthesize */ }

  try {
    const r = await client.synthesize(`Hey ${name},`, vid || undefined);
    if (!r.audio || r.dryRun) return null;
    await writeFile(path, r.audio);
    return path;
  } catch {
    return null; // degrade to the non-personalized video
  }
}
