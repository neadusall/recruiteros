/**
 * POST /api/senders/import   (require team:manage)
 *   { action: "parse",  csv }
 *        -> { header, map (auto-detected), sample (first 5 rows), rowCount }
 *   { action: "import", csv, map?, hasHeader?, provider?, dailyCap?, ownerId?, ownerName? }
 *        -> { imported, skipped[], inboxes (first 50, public) }
 *
 * Bulk-loads hundreds of SMTP inboxes into the caller's portal (workspace) and
 * optionally assigns the whole batch to one recruiter (ownerId). Idempotent: a row
 * whose email already exists refreshes that inbox instead of duplicating it.
 */
import { requireCapability, body, ok, fail } from "../../../../lib/api";
import { parseCsv, detectColumns, rowsToInboxes, addInbox, toPublic } from "../../../../lib/senders";
import type { ColumnMap, SenderProvider } from "../../../../lib/senders";

interface ImportBody {
  action?: string;
  csv?: string;
  map?: ColumnMap;
  hasHeader?: boolean;
  provider?: SenderProvider;
  dailyCap?: number;
  ownerId?: string;
  ownerName?: string;
}

export async function POST(req: Request) {
  const g = requireCapability(req, "team:manage");
  if ("response" in g) return g.response;
  const ws = g.ctx.workspace.id;
  const b = await body<ImportBody>(req);
  try {
    if (b?.action === "parse") {
      if (!b.csv) return fail("missing_csv", 422);
      const all = parseCsv(b.csv);
      if (!all.length) return fail("empty_csv", 422);
      const header = all[0];
      return ok({ header, map: detectColumns(header), sample: all.slice(1, 6), rowCount: Math.max(0, all.length - 1) });
    }
    if (b?.action === "import") {
      if (!b.csv) return fail("missing_csv", 422);
      const all = parseCsv(b.csv);
      if (!all.length) return fail("empty_csv", 422);
      const map = b.map || detectColumns(all[0] || []);
      const dataRows = b.hasHeader === false ? all : all.slice(1);
      const { inboxes, skipped } = rowsToInboxes(dataRows, map, {
        provider: b.provider, dailyCap: b.dailyCap, ownerId: b.ownerId, ownerName: b.ownerName,
      });
      const created = [];
      for (const inp of inboxes) created.push(toPublic(await addInbox(ws, inp)));
      return ok({ imported: created.length, skipped, inboxes: created.slice(0, 50) });
    }
    return fail("unknown_action", 400);
  } catch (e: any) {
    return fail(e?.message || "import_failed", e?.status || 400);
  }
}
