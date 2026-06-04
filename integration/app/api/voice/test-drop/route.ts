/**
 * POST /api/voice/test-drop
 * Fire ONE personalized drop to a number the operator controls, to verify the
 * whole path (classify -> assemble cloned voicemail -> dial with AMD). Skips the
 * compliance window (it's a manual test to your own line) but is otherwise the
 * exact production path. Session-gated; dry-run safe.
 *
 * Body: { to, firstName?, role?, company?, scriptTemplate, persona?, voiceId?, motion? }
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";
import type { Motion } from "../../../../lib/core/types";
import { testDrop, DEFAULT_PERSONA } from "../../../../lib/voice";

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<any>(req);

  const to = (b?.to || "").trim();
  const scriptTemplate = (b?.scriptTemplate || "").trim();
  if (!to) return fail("missing_fields", 422, { detail: "to (your own test number) is required" });
  if (!scriptTemplate) return fail("missing_fields", 422, { detail: "scriptTemplate is required" });

  const persona = { ...DEFAULT_PERSONA, ...(b?.persona || {}) };
  const motion: Motion = b?.motion === "bd" ? "bd" : "recruiting";

  const result = await testDrop(g.ctx.workspace.id, motion, {
    to,
    firstName: b?.firstName,
    role: b?.role,
    company: b?.company,
    scriptTemplate,
    persona,
    voiceId: b?.voiceId,
  });
  return ok(result);
}
