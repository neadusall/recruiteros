/**
 * POST /api/voice/draft
 * Customize a cloned-voice script with the LLM, enforcing the channel's length
 * window (AMD 15-25s, LinkedIn voice note 20-45s) and the speech-formatting +
 * compliance rules. The typed script is only an example; this returns a tuned
 * version the operator can preview (listen) before saving or deploying.
 *
 * Body:
 *   { channel?: "amd"|"voicenote", seed?, context?, templated?,
 *     persona?: { agentName, agentCompany, signoff? },
 *     firstName?, role?, company? }
 *
 * Session-gated. Runs in the workspace's credential scope so a white-label
 * customer's own Anthropic key is used (house key only when not isolated). With
 * no key it returns dryRun + the seed unchanged.
 */

import { requireSession, body, ok } from "../../../../lib/api";
import { withWorkspaceCreds } from "../../../../lib/connected";
import { draftVoiceScript, DEFAULT_PERSONA, type VoiceChannel } from "../../../../lib/voice";

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);

  const channel: VoiceChannel = b?.channel === "voicenote" ? "voicenote" : "amd";
  const persona = { ...DEFAULT_PERSONA, ...(b?.persona || {}) };
  const vars = {
    firstName: (b?.firstName || "").trim() || undefined,
    role: (b?.role || "").trim() || undefined,
    company: (b?.company || "").trim() || undefined,
  };

  const result = await withWorkspaceCreds(ws, () =>
    draftVoiceScript({
      channel,
      persona,
      vars,
      seed: (b?.seed || "").trim() || undefined,
      context: (b?.context || "").trim() || undefined,
      templated: b?.templated !== false,
    }),
  );

  return ok(result);
}
