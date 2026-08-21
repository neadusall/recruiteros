/**
 * Voice Drops · Voice Studio API (per-recruiter voice enrollment)
 *
 *   GET  /api/voice/enroll   -> the guided script, the whole-team roster with each
 *                               person's readiness, and the vendor account's headroom
 *   POST /api/voice/enroll   -> { action: "take" | "drop-take" | "clone" | "preview"
 *                                        | "approve" | "unapprove" | "reset" | "set-mode" }
 *
 * ACCESS MODEL (CLAUDE.md rule 2, personal artifacts). A voice is a person, not a
 * workspace setting, so a plain member may only ever act on their own row: they
 * record their own reads, mint their own clone, approve their own voice. The
 * workspace owner/admin keeps the oversight actions on anyone (clone from reads
 * already on file, revoke an approval, reset a voice that sounds wrong) via
 * `targetEmail`, but no role can record audio as somebody else — that requires
 * their microphone, which is the point.
 *
 * Every vendor call runs inside `withWorkspaceCreds` so a customer clones against
 * THEIR key, never the operator's env key.
 */

import { body, ok, fail, requireCapability } from "../../../../lib/api";
import { isWorkspaceAdmin, requesterEmail } from "../../../../lib/inmarket/ownership";
import { withWorkspaceCreds } from "../../../../lib/connected";
import {
  ENROLLMENT_PROMPTS, ENROLLMENT_MIN_TOTAL_SEC, ENROLLMENT_GOOD_TOTAL_SEC,
  enrollmentRoster, saveEnrollmentTake, dropEnrollmentTake, mintEnrollmentVoice,
  renderEnrollmentPreview, approveEnrollment, unapproveEnrollment, resetEnrollment,
  getVoiceSettings, setPerRecruiterVoice, getVoiceClientFor,
  type VoiceProvider,
} from "../../../../lib/voice";
import { listMembers } from "../../../../lib/auth/team";

/** 12 MB of decoded audio: ~4x the largest legitimate 60s 16kHz mono WAV take. */
const MAX_BYTES = 12 * 1024 * 1024;

/**
 * Resolve WHOSE row an action targets, and refuse early if the caller may not
 * touch it. `allowOthers` is false for recording (nobody records as someone else)
 * and true for the admin oversight actions.
 */
function resolveTarget(
  g: any,
  requested: unknown,
  allowOthers: boolean,
): { email: string; name: string; userId?: string } | { error: string; detail: string } {
  const me = requesterEmail(g.ctx);
  const asked = String(requested || "").trim().toLowerCase();
  if (!asked || asked === me) {
    return { email: me, name: g.ctx.user.name || me, userId: g.ctx.user.id };
  }
  if (!allowOthers) {
    return { error: "self_only", detail: "You can only record your own voice." };
  }
  if (!isWorkspaceAdmin(g.ctx)) {
    return { error: "forbidden", detail: "Only the workspace owner or an admin can do this for someone else." };
  }
  const member = listMembers(g.ctx.workspace.id).find((m) => (m.email || "").toLowerCase() === asked);
  if (!member) return { error: "not_a_member", detail: "That person is not in this workspace." };
  return { email: asked, name: member.name, userId: member.userId };
}

export async function GET(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const me = requesterEmail(g.ctx);

  const settings = getVoiceSettings(ws);
  const provider: VoiceProvider = settings.activeProvider ?? "elevenlabs";

  // Account headroom up front. A recruiter finding out mid-flow that the plan is
  // out of voice slots — after recording 75 seconds — is the worst possible time
  // to learn it, so the studio can warn before the first take.
  const account = await withWorkspaceCreds(ws, () => {
    const client = getVoiceClientFor(provider);
    return client.accountStatus ? client.accountStatus() : Promise.resolve({ configured: client.configured() });
  }).catch(() => ({ configured: false, error: "account_check_failed" }));

  const roster = enrollmentRoster(ws, me, g.ctx.user.id);

  return ok({
    you: { email: me, name: g.ctx.user.name, isAdmin: isWorkspaceAdmin(g.ctx) },
    prompts: ENROLLMENT_PROMPTS,
    minTotalSec: ENROLLMENT_MIN_TOTAL_SEC,
    goodTotalSec: ENROLLMENT_GOOD_TOTAL_SEC,
    provider,
    account,
    // Default is ON: once anyone has enrolled, drops should speak as their sender.
    perRecruiterVoice: settings.perRecruiterVoice !== false,
    roster,
  });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const me = requesterEmail(g.ctx);
  const b = await body<any>(req);
  const action = String(b?.action || "").trim();

  /* ---- workspace-level switch: one house voice vs. per-recruiter voices ---- */
  if (action === "set-mode") {
    if (!isWorkspaceAdmin(g.ctx)) return fail("forbidden", 403, { detail: "Only the owner or an admin can change this." });
    const settings = setPerRecruiterVoice(ws, b?.perRecruiterVoice !== false);
    return ok({ perRecruiterVoice: settings.perRecruiterVoice !== false });
  }

  /* ---- record one guided read (self only) ---- */
  if (action === "take") {
    const t = resolveTarget(g, b?.targetEmail, false);
    if ("error" in t) return fail(t.error, t.error === "self_only" ? 403 : 422, { detail: t.detail });

    const promptId = String(b?.promptId || "").trim();
    if (!ENROLLMENT_PROMPTS.some((p) => p.id === promptId)) {
      return fail("bad_prompt", 422, { detail: "Unknown read." });
    }
    const mime = b?.mime === "audio/wav" ? "audio/wav" : b?.mime === "audio/mpeg" ? "audio/mpeg" : null;
    if (!mime) return fail("bad_mime", 422, { detail: "Audio must be wav or mp3." });

    const b64 = typeof b?.audio === "string" ? b.audio : "";
    if (!b64) return fail("missing_fields", 422, { detail: "No audio was sent." });
    let bytes: Buffer;
    try {
      bytes = Buffer.from(b64.replace(/^data:[^,]*,/, ""), "base64");
    } catch {
      return fail("bad_audio", 422, { detail: "That audio could not be read." });
    }
    if (!bytes.length) return fail("bad_audio", 422, { detail: "That take was empty." });
    if (bytes.length > MAX_BYTES) return fail("too_large", 413, { detail: "That take is too long. Keep each read under a minute." });

    const durationSec = Number.isFinite(b?.durationSec) ? Number(b.durationSec) : 0;
    if (durationSec <= 0) return fail("bad_audio", 422, { detail: "That take had no length." });

    try {
      const row = await saveEnrollmentTake({
        workspaceId: ws,
        email: t.email,
        displayName: t.name,
        userId: t.userId,
        promptId,
        audio: bytes,
        mime,
        durationSec,
        peak: Number.isFinite(b?.peak) ? Number(b.peak) : undefined,
        consentStatement: typeof b?.consentStatement === "string" ? b.consentStatement : undefined,
        actorEmail: me,
      });
      return ok({ enrollment: row, roster: enrollmentRoster(ws, me, g.ctx.user.id) });
    } catch (e: any) {
      return fail(e?.message || "take_failed", e?.status ?? 500);
    }
  }

  /* ---- delete one read ---- */
  if (action === "drop-take") {
    const t = resolveTarget(g, b?.targetEmail, true);
    if ("error" in t) return fail(t.error, t.error === "forbidden" ? 403 : 422, { detail: t.detail });
    const takeId = String(b?.takeId || "").trim();
    if (!takeId) return fail("missing_fields", 422, { detail: "Which read?" });
    await dropEnrollmentTake(ws, t.email, takeId);
    return ok({ roster: enrollmentRoster(ws, me, g.ctx.user.id) });
  }

  /* ---- mint the clone ---- */
  if (action === "clone") {
    const t = resolveTarget(g, b?.targetEmail, true);
    if ("error" in t) return fail(t.error, t.error === "forbidden" ? 403 : 422, { detail: t.detail });

    const settings = getVoiceSettings(ws);
    const res = await withWorkspaceCreds(ws, () =>
      mintEnrollmentVoice(ws, t.email, {
        actorEmail: me,
        provider: settings.activeProvider ?? "elevenlabs",
        workspaceName: g.ctx.workspace.name,
      }),
    );
    if (!res.ok) {
      return fail(res.error || "clone_failed", res.error === "not_ready" ? 422 : 502, {
        detail: res.detail,
        roster: enrollmentRoster(ws, me, g.ctx.user.id),
      });
    }
    // Render the approval preview in the same request: a minted voice nobody has
    // heard is not a finished step, and making it one round-trip means the
    // recruiter presses "Create my voice" and immediately hears the result.
    const preview = await withWorkspaceCreds(ws, () => renderEnrollmentPreview(ws, t.email));
    return ok({
      voiceId: res.voiceId,
      preview: preview.ok ? preview.url : undefined,
      previewError: preview.ok ? undefined : preview.detail,
      roster: enrollmentRoster(ws, me, g.ctx.user.id),
    });
  }

  /* ---- re-render the preview line ---- */
  if (action === "preview") {
    const t = resolveTarget(g, b?.targetEmail, true);
    if ("error" in t) return fail(t.error, t.error === "forbidden" ? 403 : 422, { detail: t.detail });
    const res = await withWorkspaceCreds(ws, () => renderEnrollmentPreview(ws, t.email));
    if (!res.ok) return fail(res.error || "preview_failed", 502, { detail: res.detail });
    return ok({ url: res.url, roster: enrollmentRoster(ws, me, g.ctx.user.id) });
  }

  /* ---- approve / withdraw approval ---- */
  if (action === "approve" || action === "unapprove") {
    // Approving is an attestation about how YOUR voice sounds, so members may
    // only approve their own. An admin can withdraw anyone's (a bad voice must be
    // stoppable by whoever notices), but cannot approve on someone's behalf.
    const t = resolveTarget(g, b?.targetEmail, action === "unapprove");
    if ("error" in t) return fail(t.error, t.error === "forbidden" || t.error === "self_only" ? 403 : 422, { detail: t.detail });
    const row = action === "approve"
      ? approveEnrollment(ws, t.email, me)
      : unapproveEnrollment(ws, t.email, me);
    if (!row) return fail("not_found", 404, { detail: "Create the voice first." });
    return ok({ enrollment: row, roster: enrollmentRoster(ws, me, g.ctx.user.id) });
  }

  /* ---- reset ---- */
  if (action === "reset") {
    const t = resolveTarget(g, b?.targetEmail, true);
    if ("error" in t) return fail(t.error, t.error === "forbidden" ? 403 : 422, { detail: t.detail });
    // Deleting the vendor-side voice is what actually frees a voice slot; keeping
    // it is the safe default because campaigns may still reference the id.
    const res = await withWorkspaceCreds(ws, () =>
      resetEnrollment(ws, t.email, { deleteRemoteVoice: b?.deleteRemoteVoice === true }),
    );
    return ok({ ...res, roster: enrollmentRoster(ws, me, g.ctx.user.id) });
  }

  return fail("unknown_action", 400, { detail: "That action is not supported." });
}
