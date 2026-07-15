/**
 * RecruitersOS · LinkedIn OS
 * Voice notes: recordings, templates, AI-personalized scripts, synthesis and
 * the approval queue. Generation is provider-abstracted through the existing
 * lib/voice VoiceCloneClient (ElevenLabs / Cartesia / Hume / manual upload);
 * nothing here talks to Unipile. The output of this module is an audio asset
 * plus a LinkedIn ACTION REQUEST, and the shared engine does the rest.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { rid, nowIso } from "../../core/ids";
import { getVoiceClientFor, type VoiceProvider } from "../../voice/provider";
import { voiceApprovals, voiceAssets } from "./store";
import type { PersonIdentity, VoiceApprovalItem, VoiceAsset } from "./types";

/* ---------------- audio file storage ---------------- */

function audioDir(): string {
  if (process.env.LINKEDIN_VOICE_DIR) return process.env.LINKEDIN_VOICE_DIR;
  const base = process.env.ROS_DATA_DIR
    ?? (process.env.NODE_ENV === "production" ? "/data" : path.join(process.cwd(), ".data"));
  return path.join(base, "linkedin-voice");
}

function safeFile(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function writeAudioFile(bytes: Buffer, ext = "mp3"): Promise<string> {
  const dir = audioDir();
  await fs.mkdir(dir, { recursive: true });
  const file = `${rid("livn")}.${safeFile(ext)}`;
  await fs.writeFile(path.join(dir, file), bytes);
  return file;
}

export async function readAudioFile(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(audioDir(), safeFile(file)));
  } catch {
    return null;
  }
}

/** Public URL the provider (and the browser preview) fetches audio from. */
export function voiceAudioUrl(file: string): string {
  const base = process.env.RECRUITEROS_APP_URL ?? "https://recruitersos.co";
  return `${base}/api/linkedin/os/audio/${encodeURIComponent(file)}`;
}

/* ---------------- assets ---------------- */

export async function listVoiceAssets(workspaceId: string): Promise<VoiceAsset[]> {
  const all = await voiceAssets.all();
  return all.filter((a) => a.workspaceId === workspaceId);
}

export async function getVoiceAsset(workspaceId: string, id: string): Promise<VoiceAsset | null> {
  const all = await voiceAssets.all();
  return all.find((a) => a.workspaceId === workspaceId && a.id === id) ?? null;
}

export interface SaveVoiceAssetInput {
  id?: string;
  name: string;
  mode: VoiceAsset["mode"];
  script?: string;
  provider?: string;
  voiceId?: string;
  tags?: string[];
  category?: string;
  isTemplate?: boolean;
  /** base64 audio for uploads / browser recordings. */
  audioBase64?: string;
  audioExt?: string;
  durationSec?: number;
}

export async function saveVoiceAsset(workspaceId: string, input: SaveVoiceAssetInput): Promise<VoiceAsset> {
  const all = await voiceAssets.all();
  let asset = input.id
    ? all.find((a) => a.workspaceId === workspaceId && a.id === input.id)
    : undefined;
  if (!asset) {
    asset = {
      id: rid("lvna"),
      workspaceId,
      name: input.name || "Untitled voice note",
      mode: input.mode,
      tags: [],
      isTemplate: input.isTemplate ?? false,
      stats: { sent: 0, replies: 0 },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    all.push(asset);
  }
  asset.name = input.name || asset.name;
  asset.mode = input.mode ?? asset.mode;
  if (input.script !== undefined) asset.script = input.script;
  if (input.provider !== undefined) asset.provider = input.provider;
  if (input.voiceId !== undefined) asset.voiceId = input.voiceId;
  if (input.tags) asset.tags = input.tags.slice(0, 20);
  if (input.category !== undefined) asset.category = input.category;
  if (input.isTemplate !== undefined) asset.isTemplate = input.isTemplate;
  if (input.durationSec !== undefined) asset.durationSec = input.durationSec;
  if (input.audioBase64) {
    const bytes = Buffer.from(input.audioBase64.replace(/^data:[^;]+;base64,/, ""), "base64");
    asset.audioFile = await writeAudioFile(bytes, input.audioExt ?? "mp3");
  }
  asset.updatedAt = nowIso();
  voiceAssets.save();
  return asset;
}

export async function duplicateVoiceAsset(workspaceId: string, id: string): Promise<VoiceAsset | null> {
  const src = await getVoiceAsset(workspaceId, id);
  if (!src) return null;
  const all = await voiceAssets.all();
  const copy: VoiceAsset = {
    ...src,
    id: rid("lvna"),
    name: `${src.name} (copy)`,
    stats: { sent: 0, replies: 0 },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  all.push(copy);
  voiceAssets.save();
  return copy;
}

export async function deleteVoiceAsset(workspaceId: string, id: string): Promise<boolean> {
  const all = await voiceAssets.all();
  const i = all.findIndex((a) => a.workspaceId === workspaceId && a.id === id);
  if (i < 0) return false;
  all.splice(i, 1);
  voiceAssets.save();
  return true;
}

export async function bumpVoiceStat(workspaceId: string, id: string, key: "sent" | "replies"): Promise<void> {
  const asset = await getVoiceAsset(workspaceId, id);
  if (!asset) return;
  asset.stats[key] += 1;
  voiceAssets.save();
}

/* ---------------- personalization + synthesis ---------------- */

export interface PersonContext {
  first_name?: string;
  full_name?: string;
  current_company?: string;
  current_title?: string;
  previous_company?: string;
  job_title?: string;
  industry?: string;
  location?: string;
  signal?: string;
  company_trigger?: string;
  candidate_background?: string;
  shared_context?: string;
}

export function contextFromIdentity(identity: PersonIdentity, extra: Partial<PersonContext> = {}): PersonContext {
  const first = (identity.fullName ?? "").trim().split(/\s+/)[0] || undefined;
  return {
    first_name: first,
    full_name: identity.fullName,
    current_company: identity.company,
    current_title: identity.title,
    ...extra,
  };
}

/** Fill {variable} tokens; unresolved tokens are dropped cleanly. */
export function renderScript(template: string, ctx: PersonContext): string {
  return template
    .replace(/\{([a-z_]+)\}/gi, (_, key: string) => {
      const v = (ctx as Record<string, string | undefined>)[key.toLowerCase()];
      return v ?? "";
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ([,.!?])/g, "$1")
    .trim();
}

/**
 * AI-personalized script: variables filled, then optionally polished by the
 * LLM into a natural 20 to 45 second spoken note. Falls back to the plain
 * substitution when the LLM is unavailable, so generation never blocks.
 */
export async function personalizeScript(template: string, ctx: PersonContext): Promise<string> {
  const base = renderScript(template, ctx);
  try {
    const { anthropicClient } = await import("../../sourcing/anthropic");
    const { stripDashes } = await import("../../text/dashes");
    const client = anthropicClient();
    const model = process.env.RECRUITEROS_LLM_MODEL ?? "claude-sonnet-4-6";
    const res = await client.messages.create({
      model,
      max_tokens: 400,
      system: [
        "You polish short spoken LinkedIn voice note scripts.",
        "Keep it 20 to 45 seconds when spoken (roughly 55 to 120 words).",
        "Natural, warm, specific; first person; no bullet points; no emojis.",
        "Never use dashes of any kind. Return ONLY the script text.",
      ].join(" "),
      messages: [{
        role: "user",
        content: `Person context: ${JSON.stringify(ctx)}\n\nDraft script:\n${base}`,
      }],
    });
    const text = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return text ? stripDashes(text) : base;
  } catch {
    return base;
  }
}

export interface SynthesizedNote {
  file: string;
  url: string;
  dryRun: boolean;
}

/** Text to speech through the configured voice provider; saves the MP3. */
export async function synthesizeNote(
  script: string,
  provider?: string,
  voiceId?: string,
): Promise<SynthesizedNote> {
  const client = getVoiceClientFor((provider as VoiceProvider) || undefined);
  const out = await client.synthesize(script, voiceId || undefined);
  if (!out.audio) {
    // Dry-run (provider unconfigured): no bytes, surface it honestly.
    return { file: "", url: "", dryRun: true };
  }
  const ext = out.contentType.includes("wav") ? "wav" : "mp3";
  const file = await writeAudioFile(out.audio, ext);
  return { file, url: voiceAudioUrl(file), dryRun: false };
}

/**
 * Resolve the audio for a ledger voice_note action at execution time:
 * static assets return their recording; AI assets render + synthesize per
 * person. Returns null when audio cannot be produced (executor fails the
 * action with the reason).
 */
export async function renderVoiceForAction(
  workspaceId: string,
  voiceAssetId: string,
  identity: PersonIdentity,
  extraCtx: Partial<PersonContext> = {},
): Promise<{ url: string; script?: string } | { error: string }> {
  const asset = await getVoiceAsset(workspaceId, voiceAssetId);
  if (!asset) return { error: "voice_asset_missing" };
  if (asset.mode === "static") {
    if (!asset.audioFile) return { error: "voice_asset_has_no_recording" };
    return { url: voiceAudioUrl(asset.audioFile) };
  }
  if (!asset.script) return { error: "voice_asset_has_no_script" };
  const script = await personalizeScript(asset.script, contextFromIdentity(identity, extraCtx));
  const synth = await synthesizeNote(script, asset.provider, asset.voiceId);
  if (synth.dryRun) return { error: "voice_provider_not_configured" };
  return { url: synth.url, script };
}

/* ---------------- approval queue ---------------- */

export async function listVoiceApprovals(workspaceId: string, status?: VoiceApprovalItem["status"]): Promise<VoiceApprovalItem[]> {
  const all = await voiceApprovals.all();
  return all.filter((v) => v.workspaceId === workspaceId && (!status || v.status === status));
}

export async function addVoiceApproval(item: Omit<VoiceApprovalItem, "id" | "createdAt" | "status">): Promise<VoiceApprovalItem> {
  const all = await voiceApprovals.all();
  const v: VoiceApprovalItem = { ...item, id: rid("lvap"), status: "pending", createdAt: nowIso() };
  all.push(v);
  voiceApprovals.save();
  return v;
}

export async function setVoiceApproval(
  workspaceId: string,
  id: string,
  status: "approved" | "skipped",
  edits?: { script?: string },
): Promise<VoiceApprovalItem | null> {
  const all = await voiceApprovals.all();
  const v = all.find((x) => x.workspaceId === workspaceId && x.id === id) ?? null;
  if (!v) return null;
  if (edits?.script) v.script = edits.script;
  v.status = status;
  voiceApprovals.save();
  return v;
}

/** Approved count for a campaign (drives review_first_10 auto-enable). */
export async function approvedVoiceCount(workspaceId: string, campaignId: string): Promise<number> {
  const all = await voiceApprovals.all();
  return all.filter((v) => v.workspaceId === workspaceId && v.campaignId === campaignId && v.status === "approved").length;
}
