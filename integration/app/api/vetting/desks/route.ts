/**
 * AI Vetting · Desks API
 *   GET    /api/vetting/desks?motion=   -> this workspace's vetting desks (+candidate/call counts)
 *   PUT    /api/vetting/desks           -> create/update a desk (JD, questions, voice, number)
 *   DELETE /api/vetting/desks?id=       -> remove a desk (and deprovision its assistant)
 *   POST   /api/vetting/desks           -> { action: provision | pause | resume, deskId }
 *
 * Session-gated. `provision` pushes the desk's config to the voice engine and
 * binds its number; with no Telnyx key this runs as a safe dry-run and the desk
 * still flips to "live" so the flow is exercisable end to end in dev.
 */

import { requireSession, body, ok, fail } from "../../../../lib/api";
import type { Motion } from "../../../../lib/core/types";
import {
  listDesks, getDesk, upsertDesk, deleteDesk, markDeskSynced, setDeskStatus,
  listCandidates, listCalls, provisionDesk, deprovisionDesk,
  type VettingDeskInput,
} from "../../../../lib/vetting";

function asMotion(v: unknown): Motion | undefined {
  return v === "bd" ? "bd" : v === "recruiting" ? "recruiting" : undefined;
}

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const motion = asMotion(new URL(req.url).searchParams.get("motion"));
  const desks = listDesks(ws, motion).map((d) => ({
    ...d,
    candidateCount: listCandidates(ws, d.id).length,
    callCount: listCalls(ws, d.id).length,
  }));
  return ok({ desks });
}

export async function PUT(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<VettingDeskInput>(req);
  if (!b?.name) return fail("missing_fields", 422);
  const d = upsertDesk(g.ctx.workspace.id, b);
  return ok({ desk: d });
}

export async function DELETE(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("missing_id", 422);
  const desk = getDesk(ws, id);
  if (desk) await deprovisionDesk(desk);
  return ok({ ok: deleteDesk(ws, id) });
}

export async function POST(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<{ action?: string; deskId?: string }>(req);
  if (!b?.action || !b?.deskId) return fail("missing_fields", 422);

  const desk = getDesk(ws, b.deskId);
  if (!desk) return fail("not_found", 404);

  switch (b.action) {
    case "provision": {
      if (!desk.jobDescription.trim()) return fail("no_job_description", 422);
      if (!desk.phoneNumber) return fail("no_phone_number", 422);
      setDeskStatus(ws, desk.id, "provisioning");
      const res = await provisionDesk(desk);
      if (res.error) {
        setDeskStatus(ws, desk.id, "draft");
        return fail("provision_failed", 502, { detail: res.error });
      }
      const updated = markDeskSynced(ws, desk.id, { assistantId: res.assistantId, status: "live" });
      return ok({ desk: updated, dryRun: res.dryRun, numberBound: res.numberBound });
    }
    case "pause":
      return ok({ desk: setDeskStatus(ws, desk.id, "paused") });
    case "resume":
      return ok({ desk: setDeskStatus(ws, desk.id, desk.assistantId ? "live" : "draft") });
    default:
      return fail("unknown_action", 422);
  }
}
