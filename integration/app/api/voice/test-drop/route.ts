/**
 * POST /api/voice/test-drop
 * Fire ONE personalized drop to a number the operator controls, to verify the
 * whole path (classify -> assemble cloned voicemail -> dial with AMD). Skips the
 * compliance window (it's a manual test to your own line) but is otherwise the
 * exact production path. Session-gated; dry-run safe.
 *
 * Body: { to, firstName?, role?, company?, scriptTemplate, persona?, voiceId?, motion? }
 */

import { body, ok, fail, requireCapability } from "../../../../lib/api";
import type { Motion } from "../../../../lib/core/types";
import { testDrop, DEFAULT_PERSONA } from "../../../../lib/voice";

export async function POST(req: Request) {
  const g = requireCapability(req, "voice:dial");
  if ("response" in g) return g.response;
  const b = await body<any>(req);

  const to = (b?.to || "").trim();
  const messageMode = b?.messageMode === "recording" ? "recording" as const : "script" as const;
  // Script mode: scriptTemplate is the whole message (required). Recording mode:
  // the message is the pre-recorded pitch (recordingId required) with an optional
  // personalized AI intro (introTemplate; empty = drop the recording alone).
  const scriptTemplate = messageMode === "recording"
    ? (b?.introTemplate ?? b?.scriptTemplate ?? "").trim()
    : (b?.scriptTemplate || "").trim();
  if (!to) return fail("missing_fields", 422, { detail: "to (your own test number) is required" });
  if (messageMode === "script" && !scriptTemplate) return fail("missing_fields", 422, { detail: "scriptTemplate is required" });
  if (messageMode === "recording" && !b?.recordingId) return fail("missing_fields", 422, { detail: "recordingId is required (pick one in the Recordings tab)" });

  const persona = { ...DEFAULT_PERSONA, ...(b?.persona || {}) };
  const motion: Motion = b?.motion === "bd" ? "bd" : "recruiting";

  try {
    const result = await testDrop(g.ctx.workspace.id, motion, {
      to,
      firstName: b?.firstName,
      role: b?.role,
      company: b?.company,
      scriptTemplate,
      persona,
      voiceId: b?.voiceId,
      messageMode,
      recordingId: b?.recordingId,
    });
    return ok(result);
  } catch (e: any) {
    // Never leak a bare 500 to the Test tab — surface the real reason so the
    // operator can act on it (bad voice id, Telnyx 4xx, missing key, ...).
    return fail("test_failed", 502, { detail: e?.message || "unexpected error firing the test drop" });
  }
}
