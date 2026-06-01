/**
 * GET    /api/sequences?motion=  -> list this workspace's sequences (the
 *                                   channel message-builders authored under
 *                                   Campaigns)
 * PUT    /api/sequences          -> create or update one sequence
 * DELETE /api/sequences?id=      -> remove a sequence
 *
 * Sequences hold message content only; assigning prospects + deploying happens
 * in Campaign Studio. Session-gated (every role that works outreach can author).
 */

import { listSequences, upsertSequence, deleteSequence, type SequenceInput } from "../../../lib/sequences";
import { requireSession, body, ok, fail } from "../../../lib/api";
import type { Motion } from "../../../lib/core/types";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const m = new URL(req.url).searchParams.get("motion");
  const motion = m === "bd" ? "bd" : m === "recruiting" ? "recruiting" : undefined;
  return ok({ sequences: listSequences(g.ctx.workspace.id, motion as Motion | undefined) });
}

export async function PUT(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const b = await body<SequenceInput>(req);
  if (!b?.name || !b?.channel) return fail("missing_fields", 422);
  return ok({ sequence: upsertSequence(g.ctx.workspace.id, b) });
}

export async function DELETE(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("missing_id", 422);
  return ok({ ok: deleteSequence(g.ctx.workspace.id, id) });
}
