/**
 * In-Market · Voice Studio — clone the operator's OWN voice for personalized name greetings.
 *
 * GET  /api/in-market/voice
 *      -> { voice, providerConfigured, provider, lipSync:{configured,model} } — the workspace's
 *         cloned-voice + lip-sync readiness, for the Studio's "Your voice" card.
 *
 * POST /api/in-market/voice
 *      { action:"clone", clipId, name?, force? }  -> Instant-Voice-Clone the operator from a
 *                                                    recorded clip's audio; store one voice/workspace.
 *      { action:"forget" }                        -> drop the clone (so a fresh recording can re-clone).
 *      { action:"preview", name, clipId?, voiceId? }
 *          -> synthesize "Hey {name}," in the resolved cloned voice, re-mastered to pair with the
 *             given clip's recording (lib/inmarket/audioBlend), and stream the audio back — the
 *             Studio's "hear a test greeting" button. Costs one tiny TTS call, cached per name.
 *
 * Every handler resolves credentials through withWorkspaceCreds so the ElevenLabs key pasted in
 * Command → Connected works here with no redeploy (falls back to the VOICE_CLONE_API_KEY env).
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";
import { withWorkspaceCreds } from "../../../../lib/connected";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  const { getWorkspaceVoice } = await import("../../../../lib/inmarket/voiceClone");
  const { getVoiceClient } = await import("../../../../lib/voice/provider");
  const { lipSyncConfigured, lipSyncModelLabel } = await import("../../../../lib/inmarket/lipSync");

  return withWorkspaceCreds(ws, async () => {
    const client = getVoiceClient();
    return ok({
      voice: await getWorkspaceVoice(ws),
      provider: client.id,
      providerConfigured: client.configured(),
      lipSync: { configured: lipSyncConfigured(), model: lipSyncModelLabel() },
    });
  });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  const b = await body<any>(req);
  const action = String(b?.action ?? "clone");

  if (action === "forget") {
    const { forgetWorkspaceVoice } = await import("../../../../lib/inmarket/voiceClone");
    return ok({ forgot: await forgetWorkspaceVoice(ws) });
  }

  if (action === "clone") {
    const clipId = String(b?.clipId ?? "").trim();
    if (!clipId) return fail("missing clipId", 422);
    const { cloneVoiceFromClip } = await import("../../../../lib/inmarket/voiceClone");
    const r = await withWorkspaceCreds(ws, () =>
      cloneVoiceFromClip(ws, clipId, {
        name: b?.name ? String(b.name).slice(0, 60) : undefined,
        force: b?.force === true,
        motion: b?.motion === "bd" ? "bd" : "recruiting",
      }),
    );
    return r.ok ? ok(r) : fail(r.error || r.status, 400, { status: r.status });
  }

  if (action === "preview") {
    const { cleanFirstName, nameIntroAudio } = await import("../../../../lib/inmarket/nameAudio");
    const name = cleanFirstName(String(b?.name ?? ""));
    if (!name) return fail("give a real first name to preview", 422);

    const { resolveVoiceId } = await import("../../../../lib/inmarket/voiceClone");
    const { localClipPath, listClips } = await import("../../../../lib/inmarket/roleVideo");
    const { blendIntroToBody } = await import("../../../../lib/inmarket/audioBlend");
    const { readFile, unlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { randomUUID } = await import("node:crypto");

    return withWorkspaceCreds(ws, async () => {
      const vid = await resolveVoiceId(ws, b?.voiceId ? String(b.voiceId) : undefined);
      const introPath = await nameIntroAudio(name, vid);
      if (!introPath) return fail("voice not configured — connect ElevenLabs and clone your voice first", 400);

      // Blend against the given clip (or the workspace's latest recording) so the preview is the
      // EXACT audio a render would splice. No clip → play the raw cloned-voice greeting.
      let clipId = String(b?.clipId ?? "").trim();
      if (!clipId) clipId = (await listClips(ws))[0]?.id ?? "";
      let audioPath = introPath;
      let contentType = "audio/mpeg";
      let tmp: string | null = null;
      if (clipId) {
        const clipFile = await localClipPath(clipId);
        if (clipFile) {
          tmp = join(tmpdir(), `ros-greet-${randomUUID()}.wav`);
          const blended = await blendIntroToBody(introPath, clipFile, tmp).catch(() => null);
          if (blended) { audioPath = blended; contentType = "audio/wav"; }
          else tmp = null;
        }
      }
      const bytes = await readFile(audioPath);
      if (tmp) await unlink(tmp).catch(() => {});
      return new Response(bytes as any, {
        status: 200,
        headers: { "Content-Type": contentType, "Content-Length": String(bytes.length), "Cache-Control": "no-store" },
      });
    });
  }

  return fail("unknown action", 422);
}
