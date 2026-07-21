/**
 * POST /api/voice/preview
 * Assemble a voicemail and hand back the ORDERED audio URLs so the operator (and
 * a recruiter) can LISTEN to it in the browser before launching a campaign — the
 * exact synthesis path a real drop uses, but it never dials anything.
 *
 * Body (either form):
 *   { campaignId }                              -> preview that campaign's script + voice
 *   { scriptTemplate, persona?, voiceId?, provider? }  -> preview an ad-hoc script
 * Optional sample merge vars: { firstName?, role?, company? }
 *
 * Session-gated. Runs in the workspace's credential scope so it uses THEIR voice
 * provider. When the provider isn't keyed it returns dryRun:true (no audio) so the
 * UI can tell the user to connect a provider first.
 */

import { body, ok, fail, requireCapability } from "../../../../lib/api";
import { withWorkspaceCreds } from "../../../../lib/connected";
import {
  getCampaign, activeVoiceRef, segmentScript, assembleDrop, DEFAULT_PERSONA,
  type VoiceProvider,
} from "../../../../lib/voice";

export async function POST(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);

  // Resolve the script + voice from a campaign, or from an ad-hoc payload.
  let scriptTemplate = "";
  let persona = { ...DEFAULT_PERSONA };
  let voiceId: string | undefined = (b?.voiceId || "").trim() || undefined;
  let provider: VoiceProvider | undefined =
    b?.provider === "cartesia" || b?.provider === "elevenlabs" || b?.provider === "hume"
      ? b.provider
      : undefined;

  if (b?.campaignId) {
    const c = getCampaign(ws, b.campaignId);
    if (!c) return fail("not_found", 404);
    scriptTemplate = c.scriptTemplate;
    persona = { ...DEFAULT_PERSONA, ...c.persona };
    if (!voiceId && c.voiceId) { voiceId = c.voiceId; provider = c.voiceProvider; }
  } else {
    scriptTemplate = (b?.scriptTemplate || "").trim();
    persona = { ...DEFAULT_PERSONA, ...(b?.persona || {}) };
  }
  if (!scriptTemplate) return fail("missing_fields", 422, { detail: "campaignId or scriptTemplate is required" });

  // Fall back to the workspace's chosen ACTIVE engine/voice, so "Listen first"
  // previews the exact provider + voice that real tests and sends will use
  // (deterministic — same resolver the campaign send path uses).
  if (!voiceId) {
    const active = activeVoiceRef(ws);
    if (active.voiceId || active.provider) { voiceId = active.voiceId; provider = active.provider; }
  }

  // Friendly sample values so the preview sounds like a real, personalized drop.
  const vars = {
    firstName: (b?.firstName || "Alex").trim(),
    role: (b?.role || "VP of Sales").trim(),
    company: (b?.company || "Acme").trim(),
  };

  const segments = segmentScript(scriptTemplate, vars, persona);
  const drop = await withWorkspaceCreds(ws, () => assembleDrop(segments, { provider, voiceId }));

  return ok({
    playlist: drop.playlist,
    dryRun: drop.dryRun,
    synthesized: drop.synthesized,
    cached: drop.cached,
    clips: segments.length,
    rendered: segments.map((s) => s.text).join(" "),
    voice: { provider: provider || null, voiceId: voiceId || null },
  });
}
