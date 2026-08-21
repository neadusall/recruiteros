/**
 * Role Recruiter: find qualified people who are open to work, and reach them.
 *
 * GET  -> the whole view (readiness, saved searches, seats, queue, sent, stats).
 *         ?summary=1 returns tallies only, for the nav badge.
 *
 * POST actions:
 *   scan            { huntId? }        -> run now (the tick does this too)
 *   hunt_save       { ...hunt }        -> create or update a saved search
 *   hunt_remove     { id }
 *   hunt_toggle     { id, active }
 *   approve         { id, text? }      -> send this touch through the engine
 *   edit            { id, text }
 *   skip            { id }
 *   push            { ids[], listName? } -> into Candidates as a saved list
 *   pause / resume  {}
 *   auto_on / auto_off {}              -> autopilot: send drafts hands-free
 *   limits_set      { perDay?, perWeek? }
 *
 * Session-gated on outreach:send, the same capability as Role Hunter.
 */
import { ok, fail, body, requireCapability } from "../../../lib/api";
import {
  roleRecruiterView, scanWorkspace, saveHunt, removeHunt, toggleHunt,
  sendLead, editLead, skipLead, setPaused, setAuto, setLimits, pushToCandidates,
} from "../../../lib/linkedin/roleRecruiter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const g = requireCapability(req, "outreach:send");
  if ("response" in g) return g.response;
  const view = await roleRecruiterView(g.ctx.workspace.id);
  if (new URL(req.url).searchParams.get("summary") === "1") {
    return ok({ tallies: view.tallies });
  }
  return ok(view);
}

export async function POST(req: Request): Promise<Response> {
  const g = requireCapability(req, "outreach:send");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const who = g.ctx.user?.email;
  const b = await body<{
    action?: string; id?: string; ids?: unknown; text?: string; active?: unknown;
    huntId?: string; listName?: string; perDay?: unknown; perWeek?: unknown;
  }>(req);
  if (!b || !b.action) return fail("unknown_action");
  const view = () => roleRecruiterView(ws);

  switch (b.action) {
    case "scan": {
      const r = await scanWorkspace(ws, { huntId: b.huntId });
      return ok({ ...r, view: await view() });
    }
    case "hunt_save": {
      const hunt = await saveHunt(ws, b as unknown as Record<string, unknown>, who);
      return ok({ hunt, view: await view() });
    }
    case "hunt_remove": {
      if (!b.id) return fail("missing_id");
      await removeHunt(ws, b.id);
      return ok({ view: await view() });
    }
    case "hunt_toggle": {
      if (!b.id) return fail("missing_id");
      await toggleHunt(ws, b.id, b.active !== false);
      return ok({ view: await view() });
    }
    case "approve": {
      if (!b.id) return fail("missing_id");
      // approvedBy is what marks this a human decision to the engine, which is
      // the difference between "manual" and an autopilot send.
      const r = await sendLead(ws, b.id, b.text, who);
      return ok({ ...r, view: await view() });
    }
    case "edit": {
      if (!b.id) return fail("missing_id");
      if (!String(b.text ?? "").trim()) return fail("missing_text");
      const okd = await editLead(ws, b.id, String(b.text));
      return okd ? ok({ view: await view() }) : fail("not_found");
    }
    case "skip": {
      if (!b.id) return fail("missing_id");
      const okd = await skipLead(ws, b.id);
      return okd ? ok({ view: await view() }) : fail("not_found");
    }
    case "push": {
      const ids = Array.isArray(b.ids) ? b.ids.map(String) : b.id ? [b.id] : [];
      if (!ids.length) return fail("missing_ids");
      const r = await pushToCandidates(ws, ids, b.listName);
      return ok({ ...r, view: await view() });
    }
    case "pause":
    case "resume": {
      await setPaused(ws, b.action === "pause");
      return ok({ view: await view() });
    }
    case "auto_on":
    case "auto_off": {
      await setAuto(ws, b.action === "auto_on");
      return ok({ view: await view() });
    }
    case "limits_set": {
      await setLimits(ws, Number(b.perDay) || undefined, Number(b.perWeek) || undefined);
      return ok({ view: await view() });
    }
    default:
      return fail("unknown_action");
  }
}
