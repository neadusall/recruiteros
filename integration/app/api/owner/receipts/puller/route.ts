/**
 * /api/owner/receipts/puller  (OWNER, or a service key)
 *
 * Where the portal pullers report in. A puller is a browser session, signed in once by
 * the owner, that opens a vendor's own billing page on the day it charges and takes
 * whatever invoice it offers. That is the only channel that works for the vendors that
 * email nothing and expose no billing API, which is most of them.
 *
 * The pullers run off-platform (the spend-ledger tool on the owner's machine), because
 * they need a real logged-in session that cannot live on a server. They talk to this
 * endpoint:
 *
 *   POST multipart/form-data   one downloaded invoice: the vendor's own file plus what
 *                              was read off it. Filed against the month it belongs to.
 *   POST application/json      the sweep's heartbeat: per vendor, whether anything is
 *                              collecting at all, when it last ran, and what it found.
 *   GET                        the current puller states.
 *
 * Authenticated by an owner session OR a Bearer RECEIPTS_INGEST_KEY, so the scheduled
 * run can report unattended. Nothing here manufactures a document: a receipt row is
 * only ever created from bytes a vendor actually handed over.
 */

import { requireOwner, ok, fail, body, context } from "../../../../../lib/api";
import { isOwnerEmail } from "../../../../../lib/owner";
import {
  recordPortalReceipt, recordPullerStates, pullerStates, lastPullerReportAt,
  type PullerState,
} from "../../../../../lib/owner/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const key = process.env.RECEIPTS_INGEST_KEY;
  const h = req.headers.get("authorization") ?? "";
  if (key && h === `Bearer ${key}`) return true;
  const ctx = context(req);
  return Boolean(ctx && isOwnerEmail(ctx.user.email));
}

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  return ok({ lastReportAt: lastPullerReportAt(), states: pullerStates() });
}

export async function POST(req: Request) {
  if (!authed(req)) return fail("not_found", 404);

  const type = req.headers.get("content-type") || "";

  /* ---- one downloaded invoice ---- */
  if (type.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    if (!form) return fail("could not read the upload", 400);

    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return fail("a receipt file is required: a row here means a document exists", 400);
    }
    const vendor = String(form.get("vendor") || "").trim();
    const period = String(form.get("period") || "").trim();
    if (!vendor) return fail("vendor required", 400);
    if (!/^\d{4}-\d{2}$/.test(period)) return fail("period must be YYYY-MM", 400);

    const amountUsd = Number(form.get("amountUsd"));
    if (!isFinite(amountUsd)) return fail("amountUsd required", 400);

    const nativeAmount = Number(form.get("nativeAmount"));
    const chargedAt = String(form.get("chargedAt") || "").slice(0, 10) || undefined;

    const res = await recordPortalReceipt({
      vendor,
      period,
      amountUsd,
      chargedAt,
      reference: String(form.get("reference") || "") || undefined,
      description: String(form.get("description") || "") || undefined,
      currency: String(form.get("currency") || "") || undefined,
      nativeAmount: isFinite(nativeAmount) && nativeAmount > 0 ? nativeAmount : undefined,
      notes: String(form.get("notes") || "") || undefined,
      file: {
        bytes: Buffer.from(await file.arrayBuffer()),
        mime: file.type || "application/pdf",
        name: file.name || `${vendor}-${period}.pdf`,
      },
    });

    return ok({ filed: true, created: res.created, receiptId: res.receipt.id, hasShot: res.receipt.hasShot });
  }

  /* ---- the sweep's heartbeat ---- */
  const b = await body<{ host?: string; pullers?: Array<Partial<PullerState> & { vendor: string }> }>(req);
  if (!b || !Array.isArray(b.pullers)) return fail("pullers[] required", 400);
  const states = recordPullerStates({ host: b.host, pullers: b.pullers });
  return ok({ recorded: states.length, lastReportAt: lastPullerReportAt() });
}
