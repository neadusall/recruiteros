/**
 * Sender Health Ledger API — the living record of every sending domain and Email ID.
 *
 * GET  /api/senders/ledger                    -> fleet board (rows, open causes, totals)
 *      /api/senders/ledger?identity=domain:acme.com   -> one identity: series, timeline, blockers, shelf life
 *      /api/senders/ledger?identity=mailbox:jo@acme.com
 *      /api/senders/ledger?catalog=1          -> the written definition of every cause code
 *
 * POST /api/senders/ledger
 *      { action: "tick" }                     -> observe now (team:manage, or the cron secret)
 *      { action: "note", eventId, text }      -> annotate one recorded event
 *
 * Everything is scoped to the caller's workspace, which is the portal boundary:
 * a tenant can only ever read its own fleet's history.
 */
import { requireSession, requireCapability, body, ok, fail } from "../../../../lib/api";
import { requireCronAuth } from "../../../../lib/linkedin/auth";
import { ledgerFleet, ledgerIdentity, recordLedgerTick, annotateEvent, causeCatalog } from "../../../../lib/senders/ledger";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = requireSession(req);
  if ("response" in g) return g.response;
  const url = new URL(req.url);

  if (url.searchParams.get("catalog") === "1") {
    return ok({ catalog: causeCatalog() });
  }

  const identity = (url.searchParams.get("identity") || "").trim();
  if (identity) {
    return ok(await ledgerIdentity(g.ctx.workspace.id, identity));
  }

  const fleet = await ledgerFleet(g.ctx.workspace.id);
  // First open of the board on a portal that has never ticked would otherwise show
  // an empty table with no explanation. Kick one observation in the background and
  // tell the client to poll; the debounce inside the tick keeps this cheap.
  if (!fleet.lastTickAt) {
    recordLedgerTick().catch(() => { /* best-effort warm start */ });
    return ok({ ...fleet, warming: true });
  }
  return ok(fleet);
}

interface LedgerBody { action?: string; eventId?: string; text?: string; force?: boolean }

export async function POST(req: Request) {
  const b = (await body<LedgerBody>(req)) || {};

  // The cron path carries no session: the scheduler owns it.
  if (b.action === "tick") {
    const cron = requireCronAuth(req);
    if (cron.ok) return ok(await recordLedgerTick({ force: true }));
  }

  const g = requireSession(req);
  if ("response" in g) return g.response;

  if (b.action === "tick") {
    const cap = requireCapability(req, "team:manage");
    if ("response" in cap) return cap.response;
    return ok(await recordLedgerTick({ force: !!b.force }));
  }

  if (b.action === "note") {
    if (!b.eventId || !String(b.text || "").trim()) return fail("eventId_and_text_required");
    const by = g.ctx.user.name || g.ctx.user.email || "operator";
    const r = await annotateEvent(g.ctx.workspace.id, b.eventId, by, String(b.text).trim());
    return r.ok ? ok(r) : fail("event_not_found", 404);
  }

  return fail("unknown_action");
}
