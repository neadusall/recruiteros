/**
 * LinkedIn Automation (Command Center).
 *
 * The browser-facing, session-authed façade over the LinkedIn engine. The
 * engine's own /api/linkedin/* routes use a server-to-server bearer token and
 * are driven by the backend + scheduler; this route lets the signed-in
 * Command Center read and drive automation directly with its session cookie.
 *
 * GET  /api/automation                      -> { accounts, sequences, enrollments, events, prospects, stats }
 * POST /api/automation
 *   { action: "enroll", prospectId, sequenceId, accountId } -> { enrollment }
 *   { action: "tick" }                                      -> { processed }
 *   { action: "stop" | "resume", enrollmentId }             -> { enrollment }
 */

import {
  loadConsole,
  enrollProspect,
  runTick,
  setEnrollmentStatus,
} from "../../../lib/linkedin/console";
import { requireSession, body, ok, fail } from "../../../lib/api";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const data = await loadConsole(g.ctx.workspace.id, g.ctx.user.id);
  return ok(data);
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<any>(req);

  try {
    switch (b?.action) {
      case "enroll": {
        if (!b.prospectId || !b.sequenceId || !b.accountId) {
          return fail("missing_fields", 422, { detail: "prospectId, sequenceId and accountId are required" });
        }
        const enrollment = await enrollProspect(ws, g.ctx.user.id, b.prospectId, b.sequenceId, b.accountId);
        return ok({ enrollment }, 201);
      }
      case "tick":
        return ok(await runTick());
      case "stop":
      case "resume": {
        if (!b.enrollmentId) return fail("missing_fields", 422, { detail: "enrollmentId is required" });
        const enrollment = await setEnrollmentStatus(ws, b.enrollmentId, b.action);
        return ok({ enrollment });
      }
      default:
        return fail("unknown_action", 400);
    }
  } catch (e: any) {
    return fail(e?.message ?? "automation_failed", e?.status ?? 400);
  }
}
