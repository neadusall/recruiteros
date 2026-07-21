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
 *
 * The cloned voice speaks every "Hey {firstName}," (cached once per name). Degrades cleanly: no
 * VOICE_CLONE_API_KEY => dry-run, and the video pipeline falls back to a default voice or no name.
 */

import { body, ok, fail, requireCapability } from "../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = requireCapability(req, "sourcing:run");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;

  const { getWorkspaceVoice } = await import("../../../../lib/inmarket/voiceClone");
  const { getVoiceClient } = await import("../../../../lib/voice/provider");
  const { lipSyncConfigured, lipSyncModelLabel } = await import("../../../../lib/inmarket/lipSync");
  const client = getVoiceClient();

  return ok({
    voice: await getWorkspaceVoice(ws),
    provider: client.id,
    providerConfigured: client.configured(),
    lipSync: { configured: lipSyncConfigured(), model: lipSyncModelLabel() },
  });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "sourcing:run");
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
    const r = await cloneVoiceFromClip(ws, clipId, {
      name: b?.name ? String(b.name).slice(0, 60) : undefined,
      force: b?.force === true,
      motion: b?.motion === "bd" ? "bd" : "recruiting",
    });
    return r.ok ? ok(r) : fail(r.error || r.status, 400, { status: r.status });
  }

  return fail("unknown action", 422);
}
