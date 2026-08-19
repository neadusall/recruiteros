/**
 * /api/phone-intel/queue  — the owner-selected call queue (data only; no dialing)
 *  GET     — list queued items
 *  POST    — add selected contacts { items: [...] }
 *  DELETE  — remove one item (?id=) or clear queued (?clear=queued)
 *
 * This is the human-in-the-loop surface: the owner chooses who to call and
 * stages them here. Nothing dials until the owner starts the queue via the
 * separate owner-gated start route.
 */

import { requireCapability, ok, fail, body } from "../../../../lib/api";
import { ensureQueueReady, enqueueMany, listQueue, removeItem, clearQueue, type QueueItem } from "../../../../lib/phoneintel/queue";
import { toE164 } from "../../../../lib/voice/phone";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = requireCapability(req, "telnyx:manage");
  if ("response" in g) return g.response;
  await ensureQueueReady();
  return ok({ queue: listQueue(g.ctx.workspace.id) });
}

type Incoming = {
  companyName?: string; domain?: string; mainPhone?: string;
  first?: string; last?: string; full?: string; title?: string;
  contactId?: string; location?: string; stateCode?: string;
};

export async function POST(req: Request) {
  const g = requireCapability(req, "telnyx:manage");
  if ("response" in g) return g.response;
  await ensureQueueReady();
  const b = await body<{ items?: Incoming[] }>(req);
  const rows = Array.isArray(b?.items) ? b!.items : [];
  const clean: Array<Omit<QueueItem, "id" | "workspaceId" | "status" | "createdAt" | "updatedAt">> = [];
  const rejected: string[] = [];
  for (const r of rows) {
    const mainPhone = toE164(r.mainPhone ?? "");
    const full = (r.full ?? `${r.first ?? ""} ${r.last ?? ""}`).trim();
    if (!r.companyName || !/^\+[1-9]\d{7,14}$/.test(mainPhone) || !full) {
      rejected.push(r.full ?? r.companyName ?? "(row)");
      continue;
    }
    clean.push({
      companyName: r.companyName, domain: r.domain, mainPhone,
      first: r.first, last: r.last, full, title: r.title,
      contactId: r.contactId, location: r.location, stateCode: r.stateCode,
      addedByUserId: g.ctx.user.id,
    });
  }
  const added = enqueueMany(g.ctx.workspace.id, clean);
  return ok({ added: added.length, rejected });
}

export async function DELETE(req: Request) {
  const g = requireCapability(req, "telnyx:manage");
  if ("response" in g) return g.response;
  await ensureQueueReady();
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const clear = url.searchParams.get("clear");
  if (id) return removeItem(g.ctx.workspace.id, id) ? ok({ removed: 1 }) : fail("not_found", 404);
  if (clear === "queued") return ok({ removed: clearQueue(g.ctx.workspace.id, "queued") });
  return fail("specify id or clear=queued", 400);
}
