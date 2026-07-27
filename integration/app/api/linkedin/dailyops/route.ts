/**
 * LinkedIn Daily Ops: the per-user daily task list behind the LinkedIn and
 * LinkedIn Poster tabs. GET returns today's worksheet (auto-completion signals
 * computed live); POST ticks/unticks a task by hand. Session-scoped: every
 * user sees their own day.
 */
import { ok, fail, body, requireSession } from "../../../../lib/api";
import { buildDailyOps, setOpsTick } from "../../../../lib/linkedin/dailyops";
import { workspaceTz } from "../../../../lib/outbound/rollup";
import { localDay } from "../../../../lib/outbound/goals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  return ok(await buildDailyOps(g.ctx.workspace.id, g.ctx.user.id, g.ctx.role));
}

export async function POST(req: Request): Promise<Response> {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<{ action?: string; taskId?: string; done?: boolean }>(req);
  if (!b || b.action !== "check" || !b.taskId) return fail("unknown_action");
  const ws = g.ctx.workspace.id;
  // The day is always computed server-side so a stale client can never tick yesterday.
  const day = localDay(await workspaceTz(ws));
  await setOpsTick(ws, g.ctx.user.id, day, String(b.taskId), b.done !== false);
  return ok(await buildDailyOps(ws, g.ctx.user.id, g.ctx.role));
}
