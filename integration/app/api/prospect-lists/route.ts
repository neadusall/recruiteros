/**
 * GET    /api/prospect-lists?motion=  -> this workspace's saved prospect lists
 * PUT    /api/prospect-lists          -> create/update a named list
 * DELETE /api/prospect-lists?id=      -> remove a list
 *
 * Saved audiences authored under Prospects (bulk-select -> Save as list), pulled
 * up by name in Campaign Studio to assign as a campaign's audience. Session-gated.
 */

import {
  listProspectLists, upsertProspectList, deleteProspectList, type ProspectListInput,
} from "../../../lib/prospect-lists";
import { requireSession, body, ok, fail } from "../../../lib/api";
import type { Motion } from "../../../lib/core/types";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const m = new URL(req.url).searchParams.get("motion");
  const motion = m === "bd" ? "bd" : m === "recruiting" ? "recruiting" : undefined;
  return ok({ lists: listProspectLists(g.ctx.workspace.id, motion as Motion | undefined) });
}

export async function PUT(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<ProspectListInput>(req);
  if (!b?.name || !Array.isArray(b.prospectIds)) return fail("missing_fields", 422);
  return ok({ list: upsertProspectList(g.ctx.workspace.id, b) });
}

export async function DELETE(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("missing_id", 422);
  return ok({ ok: deleteProspectList(g.ctx.workspace.id, id) });
}
