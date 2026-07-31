/**
 * /api/owner/receipts  (OWNER, or a service key for the push)
 *
 * GET   receipt coverage across every provider we pay: which ones can fetch
 *       their own receipt unattended, which still need setting up, and which
 *       charges are sitting undocumented.
 * POST  the spend-ledger sweep reporting what it found. Authenticated by an
 *       owner session OR a Bearer RECEIPTS_INGEST_KEY so the scheduled run on
 *       the operator's machine can report in unattended.
 */

import { requireOwner, ok, fail, body, context } from "../../../../lib/api";
import { isOwnerEmail } from "../../../../lib/owner";
import { receiptStatus, recordSweep, type SweepReport } from "../../../../lib/billing/receipts";

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  return ok(receiptStatus());
}

function authed(req: Request): boolean {
  const key = process.env.RECEIPTS_INGEST_KEY || process.env.USAGE_INGEST_KEY;
  const h = req.headers.get("authorization") ?? "";
  if (key && h === `Bearer ${key}`) return true;
  const ctx = context(req);
  return Boolean(ctx && isOwnerEmail(ctx.user.email));
}

export async function POST(req: Request) {
  if (!authed(req)) return fail("not_found", 404);
  const b = await body<SweepReport>(req);
  if (!b || !Array.isArray(b.providers)) return fail("providers[] required", 400);
  const stored = recordSweep(b);
  return ok({ recorded: true, providers: stored.providers.length, status: receiptStatus() });
}
