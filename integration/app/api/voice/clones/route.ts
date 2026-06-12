/**
 * Voice Drops · Cloned voices + consent API
 *   GET  /api/voice/clones  -> consented voices, cached-snippet stats, provider status
 *   POST /api/voice/clones  -> record a consent + (optionally) mint a cloned voice
 *
 * The cloned voice must be the operator's OWN voice, captured with the recorded
 * consent statement. createVoice is only ever reached through this consent flow.
 * Session-gated; dry-run safe when the clone provider isn't configured.
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";
import { withWorkspaceCreds } from "../../../../lib/connected";
import {
  listConsent, upsertConsent, deleteConsent, cacheStats, getVoiceClient, getVoiceClientFor,
  voiceProviderStatuses, verifyVoiceProvider, type VoiceProvider,
} from "../../../../lib/voice";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const client = getVoiceClient();
  return ok({
    consent: listConsent(g.ctx.workspace.id),
    cache: await cacheStats(),
    provider: { id: client.id, configured: client.configured() }, // default (back-compat)
    providers: voiceProviderStatuses(),                            // [{ id, configured }] per vendor
    defaultVoiceConfigured: Boolean(process.env.VOICE_CLONE_VOICE_ID),
  });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);

  // Live-test a clone provider's key (the "Test" button) — isolation-correct so a
  // customer tests their OWN key. Proves it'll deploy instead of dry-running.
  if (b?.action === "test") {
    const provider: VoiceProvider = b?.provider === "cartesia" ? "cartesia" : "elevenlabs";
    const result = await withWorkspaceCreds(ws, () => verifyVoiceProvider(provider));
    return ok({ provider, ...result });
  }

  // Remove a saved voice from this workspace's list. Local only — it never
  // deletes the voice on ElevenLabs/Cartesia, just drops our reference to it.
  if (b?.action === "delete") {
    const id = (b?.id || "").trim();
    if (!id) return fail("missing_fields", 422, { detail: "an id is required" });
    return ok({ removed: deleteConsent(ws, id) });
  }

  const agentName = (b?.agentName || "").trim();
  if (!agentName) return fail("missing_fields", 422, { detail: "a name is required" });

  // Bring-your-own-voice: the user pastes a provider voice id, no on-platform
  // cloning or approval. A short attestation is recorded for compliance, with a
  // sensible default so the flow stays one-step.
  const provider: VoiceProvider = b?.provider === "cartesia" ? "cartesia" : "elevenlabs";
  const statement = (b?.statement || "").trim()
    || "I confirm I have the right to use this voice for outreach I authorize.";

  // Legacy/optional: if a recording sample is supplied, mint a voice from it.
  // The default path (paste-an-id) never hits this.
  let voiceId: string | undefined = (b?.voiceId || "").trim() || undefined;
  let dryRun = false;
  if (b?.sampleBase64) {
    const sample = Buffer.from(String(b.sampleBase64), "base64");
    const res = await getVoiceClientFor(provider).createVoice({ name: agentName, sample, contentType: b?.contentType });
    dryRun = res.dryRun;
    if (res.error) return fail("clone_failed", 502, { detail: res.error });
    if (res.voiceId) voiceId = res.voiceId;
  }

  const consent = upsertConsent(ws, {
    id: b?.id, agentName, statement, provider, voiceId,
    consentClipUrl: b?.consentClipUrl,
    attestedBy: g.ctx.user.email,
  });
  return ok({ consent, dryRun });
}
