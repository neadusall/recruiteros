/**
 * RecruitersOS · Voice Drops · Voice Studio (per-recruiter voice enrollment)
 *
 * Before this existed, a workspace had ONE voice, and getting it meant leaving
 * the product: clone yourself on the vendor's dashboard, copy the voice id, paste
 * it into a text box. So in practice a five-person desk had one person's voice on
 * every drop, or — as on the Lume workspace — no voice at all, which silently
 * demoted every drop to a dry run.
 *
 * The studio closes that loop inside the portal. A recruiter records three guided
 * reads (the first is their recorded consent), the audio is graded before a credit
 * is spent, the clone is minted from all three takes at once, and the resulting
 * voice is stamped with THEIR email — which is what makes `activeVoiceRef` able to
 * answer "whose voice speaks this drop" per recruiter instead of per workspace.
 *
 * Two rules this file exists to enforce:
 *  1. NOTHING DIALS IN AN UNAPPROVED VOICE. A minted clone is not usable until its
 *     owner has heard the preview and pressed approve. A clone that sounds wrong
 *     is worse than no clone: it burns the contact and reads as a broken robocall.
 *  2. CONSENT IS AUDIO, NOT A CHECKBOX. The consent read is a required take, kept
 *     for the life of the voice, and deleting it invalidates the enrollment.
 */

import {
  ENROLLMENT_PROMPTS, ENROLLMENT_MIN_TOTAL_SEC, ENROLLMENT_GOOD_TOTAL_SEC,
  ENROLLMENT_PREVIEW_LINE,
  type VoiceEnrollment, type EnrollmentTake, type EnrollmentPrompt,
} from "./types";
import {
  listEnrollments, getEnrollment, upsertEnrollment, deleteEnrollment,
  removeEnrollmentTake, upsertConsent, deleteConsent, listConsent,
} from "./store";
import {
  saveEnrollmentAudio, readEnrollmentAudio, deleteEnrollmentAudio,
  savePreviewAudio, audioUrl,
} from "./clones";
import { getVoiceClientFor, type VoiceProvider, type VoiceSampleInput } from "./provider";
import { listMembers } from "../auth/team";
import { rid, nowIso } from "../core/ids";

/* ---------------------------------------------------------------- quality --

   Grading happens BEFORE the clone call, not after, for one reason: an instant
   clone is cheap to mint and expensive to discover is bad. A clone fitted on a
   30-second clipped laptop-mic take will synthesize happily forever, sounding
   slightly wrong on every drop, and the only tell is a reply rate that never
   arrives. So the gate is deliberately opinionated and refuses early.            */

export interface QualityIssue {
  /** Which prompt the problem is on, or "overall". */
  scope: string;
  /** Blocks cloning vs. worth fixing. */
  severity: "block" | "warn";
  message: string;
}

export interface QualityReport {
  totalSec: number;
  takeCount: number;
  hasConsent: boolean;
  /** Enough good audio to mint a clone. */
  canClone: boolean;
  /** 0-100, what the UI shows as the readiness meter. */
  score: number;
  issues: QualityIssue[];
  /** Prompts still missing a take. */
  missingPrompts: string[];
}

function promptById(id: string): EnrollmentPrompt | undefined {
  return ENROLLMENT_PROMPTS.find((p) => p.id === id);
}

export function qualityReport(row: VoiceEnrollment | undefined): QualityReport {
  const takes = row?.takes ?? [];
  const totalSec = takes.reduce((n, t) => n + (t.durationSec || 0), 0);
  const hasConsent = Boolean(row?.consentTakeId && takes.some((t) => t.id === row!.consentTakeId));
  const issues: QualityIssue[] = [];

  for (const t of takes) {
    const p = promptById(t.promptId);
    const label = p?.title ?? t.promptId;
    if (p && t.durationSec < p.minSec) {
      issues.push({
        scope: t.promptId, severity: "block",
        message: `${label} is only ${Math.round(t.durationSec)}s. Read the whole passage — at least ${p.minSec}s.`,
      });
    }
    // Peak is measured client-side on the raw take. Below ~0.05 the mic barely
    // registered and the clone fits mostly room tone; at 1.0 the take is clipped
    // and the distortion is baked in permanently.
    if (typeof t.peak === "number") {
      if (t.peak < 0.05) {
        issues.push({
          scope: t.promptId, severity: "block",
          message: `${label} came in almost silent. Check which mic Windows is using, move closer, and read it again.`,
        });
      } else if (t.peak > 0.985) {
        issues.push({
          scope: t.promptId, severity: "warn",
          message: `${label} is clipping. Back off the mic a few inches or turn input gain down, then re-record.`,
        });
      } else if (t.peak < 0.12) {
        issues.push({
          scope: t.promptId, severity: "warn",
          message: `${label} is quiet. Louder takes clone better.`,
        });
      }
    }
  }

  const missingPrompts = ENROLLMENT_PROMPTS
    .filter((p) => !takes.some((t) => t.promptId === p.id))
    .map((p) => p.id);

  if (!hasConsent) {
    issues.push({
      scope: "overall", severity: "block",
      message: "The consent read is required before a voice can be created.",
    });
  }
  if (totalSec < ENROLLMENT_MIN_TOTAL_SEC) {
    issues.push({
      scope: "overall", severity: "block",
      message: `Only ${Math.round(totalSec)}s recorded. A voice needs at least ${ENROLLMENT_MIN_TOTAL_SEC}s to sound like you.`,
    });
  } else if (totalSec < ENROLLMENT_GOOD_TOTAL_SEC) {
    issues.push({
      scope: "overall", severity: "warn",
      message: `${Math.round(totalSec)}s is workable. Around ${ENROLLMENT_GOOD_TOTAL_SEC}s is where it stops sounding synthetic.`,
    });
  }

  const canClone = hasConsent && !issues.some((i) => i.severity === "block");
  // The meter is length-driven (the dominant factor) with a penalty per warning,
  // so it moves as the recruiter records and drops when a take is poor.
  const lengthScore = Math.min(100, Math.round((totalSec / ENROLLMENT_GOOD_TOTAL_SEC) * 100));
  const warnCount = issues.filter((i) => i.severity === "warn").length;
  const score = Math.max(0, Math.min(100, lengthScore - warnCount * 12));

  return { totalSec, takeCount: takes.length, hasConsent, canClone, score, issues, missingPrompts };
}

/* ------------------------------------------------------------- the roster --

   The board shows every member of the workspace, enrolled or not, because the
   question an owner actually has is "who still needs to record", and a list of
   only-the-enrolled cannot answer it.                                           */

export interface RosterRow {
  email: string;
  name: string;
  userId?: string;
  role?: string;
  isYou: boolean;
  status: VoiceEnrollment["status"];
  enrollmentId?: string;
  voiceId?: string;
  provider?: VoiceProvider;
  clonedAt?: string;
  approvedAt?: string;
  previewUrl?: string;
  error?: string;
  quality: QualityReport;
  takes: Array<EnrollmentTake & { url: string; promptTitle: string }>;
  /** True when this row's voice is what a drop on their behalf would actually use. */
  liveForDrops: boolean;
}

export function enrollmentRoster(workspaceId: string, youEmail: string, youUserId?: string): RosterRow[] {
  const members = listMembers(workspaceId, youUserId);
  const rows = listEnrollments(workspaceId);
  const you = (youEmail || "").trim().toLowerCase();

  // Start from the member list, then fold in any enrollment whose person has
  // since left the workspace — their voice may still be attached to campaigns,
  // and hiding it would make an in-use voice unaccountable.
  const byEmail = new Map<string, RosterRow>();

  for (const m of members) {
    const email = (m.email || "").trim().toLowerCase();
    const row = rows.find((r) => r.email === email);
    byEmail.set(email, toRosterRow(email, m.name, row, m.userId, m.role, email === you));
  }
  for (const r of rows) {
    if (byEmail.has(r.email)) continue;
    byEmail.set(r.email, toRosterRow(r.email, r.displayName + " (removed)", r, r.userId, undefined, r.email === you));
  }

  return [...byEmail.values()].sort((a, b) => {
    // You first (you are the one who can actually record), then unenrolled
    // (the work to be done), then everyone else by name.
    if (a.isYou !== b.isYou) return a.isYou ? -1 : 1;
    const rank = (s: string) => (s === "cloned" ? 2 : s === "ready" ? 1 : 0);
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    return a.name.localeCompare(b.name);
  });
}

function toRosterRow(
  email: string,
  name: string,
  row: VoiceEnrollment | undefined,
  userId?: string,
  role?: string,
  isYou = false,
): RosterRow {
  const quality = qualityReport(row);
  return {
    email,
    name: row?.displayName || name,
    userId: row?.userId || userId,
    role,
    isYou,
    status: row?.status ?? "not_started",
    enrollmentId: row?.id,
    voiceId: row?.voiceId,
    provider: row?.provider,
    clonedAt: row?.clonedAt,
    approvedAt: row?.approvedAt,
    previewUrl: row?.previewFile ? audioUrl(row.previewFile) : undefined,
    error: row?.error,
    quality,
    takes: (row?.takes ?? []).map((t) => ({
      ...t,
      url: audioUrl(t.file),
      promptTitle: promptById(t.promptId)?.title ?? t.promptId,
    })),
    liveForDrops: Boolean(row?.voiceId && row?.approvedAt),
  };
}

/* ------------------------------------------------------------ recording ---- */

export interface SaveTakeInput {
  workspaceId: string;
  email: string;
  displayName: string;
  userId?: string;
  promptId: string;
  audio: Buffer;
  mime: "audio/mpeg" | "audio/wav";
  durationSec: number;
  peak?: number;
  /** The verbatim consent wording, sent with the consent take only. */
  consentStatement?: string;
  actorEmail: string;
}

/** Store one guided read. Replaces any previous take for the same prompt. */
export async function saveEnrollmentTake(input: SaveTakeInput): Promise<VoiceEnrollment> {
  const prompt = promptById(input.promptId);
  if (!prompt) throw Object.assign(new Error("unknown_prompt"), { status: 422 });

  // Ensure the row exists before writing audio, so an orphaned file can't outlive
  // a failed create.
  const row = upsertEnrollment(input.workspaceId, input.email, {
    displayName: input.displayName,
    userId: input.userId,
    updatedBy: input.actorEmail,
  });

  // Replacing a take: drop the old audio so re-recording six times does not leave
  // six abandoned files on the volume.
  const prior = row.takes.find((t) => t.promptId === input.promptId);
  if (prior) await deleteEnrollmentAudio(prior.file).catch(() => {});

  const id = rid("vtake");
  const file = await saveEnrollmentAudio(id, input.audio, input.mime === "audio/wav" ? "wav" : "mp3");
  const take: EnrollmentTake = {
    id,
    promptId: input.promptId,
    file,
    mime: input.mime,
    bytes: input.audio.length,
    durationSec: Math.max(0, Math.round(input.durationSec)),
    peak: typeof input.peak === "number" ? Number(input.peak.toFixed(4)) : undefined,
    createdAt: nowIso(),
  };

  const patch: Partial<VoiceEnrollment> = {
    takes: [...row.takes.filter((t) => t.promptId !== input.promptId), take]
      .sort((a, b) => a.promptId.localeCompare(b.promptId)),
    // A new take invalidates the previous failure message; the recruiter is
    // actively fixing it and a stale red banner just confuses.
    error: undefined,
  };
  if (prompt.consent) {
    patch.consentTakeId = id;
    patch.consentAt = nowIso();
    patch.consentStatement = input.consentStatement || prompt.text;
  }
  return upsertEnrollment(input.workspaceId, input.email, patch);
}

/** Delete one take (and its audio). */
export async function dropEnrollmentTake(workspaceId: string, email: string, takeId: string): Promise<VoiceEnrollment | undefined> {
  const removed = removeEnrollmentTake(workspaceId, email, takeId);
  if (removed) await deleteEnrollmentAudio(removed.file).catch(() => {});
  return getEnrollment(workspaceId, email);
}

/* --------------------------------------------------------------- cloning --- */

export interface MintResult {
  ok: boolean;
  enrollment?: VoiceEnrollment;
  voiceId?: string;
  dryRun?: boolean;
  error?: string;
  /** Human-readable, safe to show a recruiter verbatim. */
  detail?: string;
}

/** Vendor error codes translated into something a recruiter can act on. */
function explain(error: string): string {
  if (error === "voice_slots_full")
    return "The voice engine account is out of voice slots. Free one up on the account (or upgrade the plan), then try again.";
  if (error === "plan_cannot_clone")
    return "This voice engine plan cannot create cloned voices. Upgrade the plan, then try again.";
  if (error === "voice_clone_no_samples")
    return "No audio reached the voice engine. Re-record the reads and try again.";
  if (/voice_clone_401|unauthorized/i.test(error))
    return "The voice engine key was rejected. Reconnect it in Setup, then try again.";
  if (/voice_clone_network/i.test(error))
    return "Could not reach the voice engine. Check the connection and try again.";
  return error;
}

/**
 * Mint the clone from every take on file and wire it to this recruiter.
 *
 * MUST run inside `withWorkspaceCreds(workspaceId, ...)` so the workspace's own
 * vendor key is used — cloning against the operator's env key would put a
 * customer's voice on our account.
 */
export async function mintEnrollmentVoice(
  workspaceId: string,
  email: string,
  opts: { actorEmail: string; provider?: VoiceProvider; workspaceName?: string },
): Promise<MintResult> {
  const row = getEnrollment(workspaceId, email);
  if (!row) return { ok: false, error: "not_found", detail: "No recording session for this person yet." };

  const report = qualityReport(row);
  if (!report.canClone) {
    const blocker = report.issues.find((i) => i.severity === "block");
    return { ok: false, error: "not_ready", detail: blocker?.message ?? "Record the guided reads first." };
  }

  const provider: VoiceProvider = opts.provider ?? row.provider ?? "elevenlabs";

  // Read every take back off the volume. A missing file here is exactly the
  // failure the durable-cache fix was for; refuse rather than clone a partial set.
  const samples: VoiceSampleInput[] = [];
  for (const t of row.takes) {
    const audio = await readEnrollmentAudio(t.file);
    if (!audio) {
      return {
        ok: false, error: "audio_missing",
        detail: `One of the reads (${promptById(t.promptId)?.title ?? t.promptId}) is no longer on disk. Re-record it and try again.`,
      };
    }
    samples.push({
      audio,
      filename: `${t.promptId}.${t.mime === "audio/wav" ? "wav" : "mp3"}`,
      contentType: t.mime,
    });
  }

  const client = getVoiceClientFor(provider);
  const res = await client.createVoice({
    name: `${row.displayName} · RecruitersOS`,
    samples,
    removeBackgroundNoise: true,
    description: `Voice Drops outreach voice for ${row.displayName} (${row.email})${opts.workspaceName ? ", " + opts.workspaceName : ""}. Consent recorded ${row.consentAt ?? "n/a"}.`,
    labels: { app: "recruitersos", recruiter: row.email, workspace: workspaceId },
  });

  if (res.error) {
    upsertEnrollment(workspaceId, email, { error: explain(res.error), updatedBy: opts.actorEmail });
    return { ok: false, error: res.error, detail: explain(res.error) };
  }
  if (res.dryRun || !res.voiceId) {
    const detail = "The voice engine is not connected for this workspace, so nothing was created. Connect the key in Setup → Voice, then try again.";
    upsertEnrollment(workspaceId, email, { error: detail, updatedBy: opts.actorEmail });
    return { ok: false, dryRun: true, error: "not_configured", detail };
  }

  // Wire the clone to a consent row stamped with the OWNER's email — this is the
  // record `activeVoiceRef` reads when it resolves a per-recruiter voice.
  const consent = upsertConsent(workspaceId, {
    id: row.consentId,
    agentName: row.displayName,
    provider,
    voiceId: res.voiceId,
    ownerEmail: row.email,
    userId: row.userId,
    enrollmentId: row.id,
    statement: row.consentStatement || "Recorded consent on file (Voice Studio).",
    consentClipUrl: row.consentTakeId
      ? audioUrl(row.takes.find((t) => t.id === row.consentTakeId)!.file)
      : undefined,
    attestedBy: opts.actorEmail,
  });

  const updated = upsertEnrollment(workspaceId, email, {
    provider,
    voiceId: res.voiceId,
    consentId: consent.id,
    clonedAt: nowIso(),
    // A re-clone must be re-approved: the new voice is a different voice, and the
    // old approval said nothing about how this one sounds.
    approvedAt: undefined,
    previewFile: undefined,
    previewAt: undefined,
    error: undefined,
    updatedBy: opts.actorEmail,
  });

  return { ok: true, enrollment: updated, voiceId: res.voiceId };
}

/* --------------------------------------------------------------- preview --- */

export interface PreviewResult {
  ok: boolean;
  url?: string;
  dryRun?: boolean;
  error?: string;
  detail?: string;
}

/**
 * Render the "hear yourself" line in the freshly minted voice. Also runs inside
 * `withWorkspaceCreds`. Deliberately synthesized fresh (not pulled from the clip
 * cache) so it proves the whole synthesis path works with this voice id, which is
 * what approval is actually attesting to.
 */
export async function renderEnrollmentPreview(workspaceId: string, email: string): Promise<PreviewResult> {
  const row = getEnrollment(workspaceId, email);
  if (!row?.voiceId) return { ok: false, error: "no_voice", detail: "Create the voice first." };

  const first = (row.displayName || "").trim().split(/\s+/)[0] || "there";
  const text = ENROLLMENT_PREVIEW_LINE.replace(/\{first\}/g, first);

  const client = getVoiceClientFor(row.provider ?? "elevenlabs");
  let out;
  try {
    out = await client.synthesize(text, row.voiceId);
  } catch (e: any) {
    const detail = `The voice engine could not speak in this voice (${e?.message || "error"}). Try creating the voice again.`;
    upsertEnrollment(workspaceId, email, { error: detail });
    return { ok: false, error: "synth_failed", detail };
  }
  if (out.dryRun || !out.audio) {
    return { ok: false, dryRun: true, error: "not_configured", detail: "The voice engine is not connected, so there is nothing to play." };
  }

  const file = await savePreviewAudio(row.id, out.audio);
  upsertEnrollment(workspaceId, email, { previewFile: file, previewAt: nowIso(), error: undefined });
  return { ok: true, url: audioUrl(file) };
}

/** The recruiter listened and signed off. Until this, nothing dials in the voice. */
export function approveEnrollment(workspaceId: string, email: string, actorEmail: string): VoiceEnrollment | undefined {
  const row = getEnrollment(workspaceId, email);
  if (!row?.voiceId) return undefined;
  return upsertEnrollment(workspaceId, email, { approvedAt: nowIso(), updatedBy: actorEmail });
}

/** Withdraw approval without destroying the clone (e.g. "this sounds off"). */
export function unapproveEnrollment(workspaceId: string, email: string, actorEmail: string): VoiceEnrollment | undefined {
  const row = getEnrollment(workspaceId, email);
  if (!row) return undefined;
  return upsertEnrollment(workspaceId, email, { approvedAt: undefined, updatedBy: actorEmail });
}

/* ----------------------------------------------------------------- reset --- */

/**
 * Tear an enrollment down: the local row, its audio, its consent link, and
 * optionally the clone on the vendor account (which is what actually frees a
 * voice slot — deleting only our reference leaves the slot consumed forever).
 */
export async function resetEnrollment(
  workspaceId: string,
  email: string,
  opts: { deleteRemoteVoice?: boolean } = {},
): Promise<{ ok: boolean; remoteDeleted?: boolean; remoteError?: string }> {
  const row = getEnrollment(workspaceId, email);
  if (!row) return { ok: false };

  let remoteDeleted: boolean | undefined;
  let remoteError: string | undefined;
  if (opts.deleteRemoteVoice && row.voiceId) {
    const client = getVoiceClientFor(row.provider ?? "elevenlabs");
    if (client.deleteVoice) {
      const r = await client.deleteVoice(row.voiceId);
      remoteDeleted = r.ok;
      remoteError = r.error;
    }
  }

  for (const t of row.takes) await deleteEnrollmentAudio(t.file).catch(() => {});
  if (row.previewFile) await deleteEnrollmentAudio(row.previewFile).catch(() => {});
  if (row.consentId) deleteConsent(workspaceId, row.consentId);
  deleteEnrollment(workspaceId, email);

  return { ok: true, remoteDeleted, remoteError };
}

/* ------------------------------------------------------------- coverage ---- */

export interface VoiceCoverage {
  members: number;
  enrolled: number;
  approved: number;
  /** Members with no usable voice — the ones whose drops fall back or dry-run. */
  missing: string[];
  /** A workspace-level voice exists as the fallback for unenrolled recruiters. */
  hasWorkspaceFallback: boolean;
}

/** One number for the health board: can this workspace actually leave voicemails. */
export function voiceCoverage(workspaceId: string): VoiceCoverage {
  const members = listMembers(workspaceId);
  const rows = listEnrollments(workspaceId);
  const approved = rows.filter((r) => r.voiceId && r.approvedAt);
  const approvedEmails = new Set(approved.map((r) => r.email));
  return {
    members: members.length,
    enrolled: rows.filter((r) => r.voiceId).length,
    approved: approved.length,
    missing: members
      .map((m) => (m.email || "").trim().toLowerCase())
      .filter((e) => e && !approvedEmails.has(e)),
    hasWorkspaceFallback: listConsent(workspaceId).some((c) => Boolean(c.voiceId)),
  };
}
