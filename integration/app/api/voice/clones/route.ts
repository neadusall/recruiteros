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
import {
  listConsent, upsertConsent, cacheStats, getVoiceClient,
} from "../../../../lib/voice";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const client = getVoiceClient();
  return ok({
    consent: listConsent(g.ctx.workspace.id),
    cache: await cacheStats(),
    provider: { id: client.id, configured: client.configured() },
    defaultVoiceConfigured: Boolean(process.env.VOICE_CLONE_VOICE_ID),
  });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);
  const agentName = (b?.agentName || "").trim();
  const statement = (b?.statement || "").trim();
  if (!agentName || !statement) return fail("missing_fields", 422, { detail: "agentName and a consent statement are required" });

  // Mint a cloned voice from the consent recording when one was supplied and the
  // provider is configured; otherwise record the consent with any provided voiceId.
  let voiceId: string | undefined = b?.voiceId;
  let dryRun = false;
  if (b?.sampleBase64) {
    const sample = Buffer.from(String(b.sampleBase64), "base64");
    const res = await getVoiceClient().createVoice({ name: agentName, sample, contentType: b?.contentType });
    dryRun = res.dryRun;
    if (res.error) return fail("clone_failed", 502, { detail: res.error });
    if (res.voiceId) voiceId = res.voiceId;
  }

  const consent = upsertConsent(ws, {
    id: b?.id, agentName, statement, voiceId,
    consentClipUrl: b?.consentClipUrl,
    attestedBy: g.ctx.user.email,
  });
  return ok({ consent, dryRun });
}
