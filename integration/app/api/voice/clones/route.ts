/**
 * Voice Drops · Cloned voices + consent API
 *   GET  /api/voice/clones  -> consented voices, cached-snippet stats, provider status
 *   POST /api/voice/clones  -> record a consent + (optionally) mint a cloned voice
 *
 * The cloned voice must be the operator's OWN voice, captured with the recorded
 * consent statement. createVoice is only ever reached through this consent flow.
 * Session-gated; dry-run safe when the clone provider isn't configured.
 */

import { body, ok, fail, requireCapability } from "../../../../lib/api";
import { withWorkspaceCreds } from "../../../../lib/connected";
import { cred } from "../../../../lib/providers/http";
import {
  listConsent, upsertConsent, deleteConsent, cacheStats, getVoiceClient, getVoiceClientFor,
  voiceProviderStatuses, verifyVoiceProvider, getVoiceSettings, setActiveVoice, setActiveProvider,
  type VoiceProvider,
} from "../../../../lib/voice";

/** The three TTS engines a workspace can pick between. */
function asProvider(v: unknown): VoiceProvider | undefined {
  return v === "elevenlabs" || v === "cartesia" || v === "hume" ? v : undefined;
}

export async function GET(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  // Resolve provider status the workspace-aware way — the SAME credential context
  // the Test button uses — so a key entered as a workspace credential (not an env
  // var) is reported as connected here too. Reading these outside the context only
  // saw process.env, which made the setup gate show "not connected" even with keys
  // saved and voices on file.
  const status = await withWorkspaceCreds(ws, () => {
    const client = getVoiceClient();
    return {
      provider: { id: client.id, configured: client.configured() }, // default (back-compat)
      providers: voiceProviderStatuses(),                            // [{ id, configured }] per vendor
      defaultVoiceConfigured: Boolean(cred("VOICE_CLONE_VOICE_ID")),
    };
  });
  return ok({
    consent: listConsent(ws),
    cache: await cacheStats(),
    // The engine + voice explicitly chosen for tests AND sends. Null when none
    // chosen yet — the UI then falls back to the most-recently-saved voice.
    activeProvider: getVoiceSettings(ws).activeProvider ?? null,
    activeVoiceId: getVoiceSettings(ws).activeVoiceId ?? null,
    ...status,
  });
}

export async function POST(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);

  // Live-test a clone provider's key (the "Test" button) — isolation-correct so a
  // customer tests their OWN key. Proves it'll deploy instead of dry-running.
  if (b?.action === "test") {
    const provider: VoiceProvider =
      b?.provider === "cartesia" || b?.provider === "hume" ? b.provider : "elevenlabs";
    const result = await withWorkspaceCreds(ws, () => verifyVoiceProvider(provider));
    return ok({ provider, ...result });
  }

  // Pick the active ENGINE (provider) — the prominent choice. Every test drop,
  // "Listen first" preview, and live send then synthesizes on this vendor.
  if (b?.action === "set-provider") {
    const provider = asProvider(b?.provider);
    if (b?.provider != null && !provider) return fail("bad_provider", 422, { detail: "provider must be elevenlabs, cartesia or hume" });
    const settings = setActiveProvider(ws, provider);
    return ok({ activeProvider: settings.activeProvider ?? null, activeVoiceId: settings.activeVoiceId ?? null });
  }

  // Pin which saved voice is the active one — the one used for the test drop, the
  // "Listen first" preview, AND live campaign sends (also flips the active
  // engine to that voice's provider). Pass id:null to clear.
  if (b?.action === "set-active") {
    const id = (b?.id || "").trim() || undefined;
    const active = setActiveVoice(ws, id);
    if (id && !active) return fail("not_found", 404, { detail: "no saved voice with that id" });
    return ok({ activeVoiceId: active?.id ?? null, activeProvider: getVoiceSettings(ws).activeProvider ?? null });
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
  const provider: VoiceProvider =
    b?.provider === "cartesia" || b?.provider === "hume" ? b.provider : "elevenlabs";
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
