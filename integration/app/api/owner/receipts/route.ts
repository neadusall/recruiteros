/**
 * /api/owner/receipts  (OWNER ONLY)
 *
 * The receipt vault behind Owner Console -> Spend master -> "Month by month". Every dollar
 * with the invoice that proves it, laid out per service per month with a running total.
 *
 *   GET    ?months=12          -> the reconciled matrix, the per-vendor sourcing status,
 *                                 the anomaly list, and the state of the billing mailbox
 *   POST   { action:"harvest", monthsBack } -> sweep the mailbox (detached; poll the GET)
 *   POST   multipart/form-data -> attach a receipt downloaded by hand
 *   PATCH  { id, ... }         -> correct a parsed figure / reassign a vendor / mark reviewed
 *   DELETE ?id=…               -> drop one
 *
 * Nothing here mutates the mailbox: the sweep is read-only, so it can be re-run over any
 * period to backfill months that were never captured.
 */

import { requireOwner, ok, fail, body } from "../../../../lib/api";
import { listSpendItems } from "../../../../lib/owner/spendRegister";
import {
  listReceipts, addManualReceipt, updateReceipt, deleteReceipt,
  billingMailboxes, startHarvest, harvestState, lastSweeps, lastSweepAt,
  type Receipt,
} from "../../../../lib/owner/receipts";
import { buildSpendMatrix, sourcingStatus, portalPullAnomalies } from "../../../../lib/owner/spendMatrix";
import { VENDOR_SOURCES } from "../../../../lib/owner/receiptSources";
import {
  PORTAL_PULLER_VENDORS, lastPortalPulls, ensurePortalPullsReady, portalSessionState,
  portalRecipeFor, pullPortal, pullAllPortals,
} from "../../../../lib/owner/portalPullers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const months = Number(new URL(req.url).searchParams.get("months")) || 12;

  const [items, receipts] = await Promise.all([listSpendItems(), listReceipts(), ensurePortalPullsReady()]);
  const boxes = billingMailboxes();
  const matrix = buildSpendMatrix(items, receipts, { months, inboxConfigured: boxes.length > 0 });

  /* Portal pulls report their own health. A puller that broke is an anomaly in its own
     right, so it rides in the same alert list as a missing receipt rather than hiding in a
     table nobody scrolls to. */
  const pulls = lastPortalPulls();
  matrix.anomalies = [...portalPullAnomalies(pulls), ...matrix.anomalies];

  const sessions = await Promise.all(
    PORTAL_PULLER_VENDORS.map(async (v) => ({ vendor: v, ...(await portalSessionState(v)), path: undefined })),
  );

  return ok({
    matrix,
    sourcing: sourcingStatus(items, receipts, { pullers: PORTAL_PULLER_VENDORS, pulls }),
    portal: {
      vendors: PORTAL_PULLER_VENDORS.map((v) => ({ ...portalRecipeFor(v), vendor: v })),
      pulls,
      sessions,
    },
    /* The 25 most recent receipts power the drawer without shipping every artifact. */
    receipts: receipts.slice(0, 60).map(publicReceipt),
    inbox: {
      configured: boxes.length > 0,
      mailboxes: boxes.map((b) => ({ user: b.user, host: b.host, port: b.port, inherited: !!b.inherited })),
      lastSweepAt: lastSweepAt(),
      harvest: harvestState(),
      sweeps: lastSweeps(),
      /* Where to have vendors send their receipts, and what to set if it should be its own
         mailbox rather than the one the resume inbox already uses. */
      envKeys: ["BILLING_INBOX_USER", "BILLING_INBOX_PASS", "BILLING_INBOX_HOST", "BILLING_INBOX_PORT"],
    },
    knownVendors: VENDOR_SOURCES.map((v) => ({ vendor: v.vendor, channel: v.channel, portal: v.portal, from: v.from })),
  });
}

/** Strip the bulky excerpt from list payloads; the drawer fetches it per receipt. */
function publicReceipt(r: Receipt) {
  const { excerpt, ...rest } = r;
  return { ...rest, excerptPreview: (excerpt || "").slice(0, 240) };
}

export async function POST(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;

  /* ---- hand-attached receipt (the backfill path for portal-only vendors) ---- */
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    if (!form) return fail("bad_form", 400);
    const file = form.get("file");
    const vendor = String(form.get("vendor") || "").trim();
    const period = String(form.get("period") || "").trim();
    const amount = Number(form.get("amountUsd"));
    if (!vendor) return fail("vendor_required", 400);
    if (!/^\d{4}-\d{2}$/.test(period)) return fail("period_required", 400);
    if (!Number.isFinite(amount)) return fail("amount_required", 400);

    let filePart: { bytes: Buffer; mime: string; name: string } | undefined;
    if (file && typeof file === "object" && "arrayBuffer" in file) {
      const f = file as File;
      const bytes = Buffer.from(await f.arrayBuffer());
      if (bytes.length > 20 * 1024 * 1024) return fail("file_too_large", 413);
      if (bytes.length) filePart = { bytes, mime: f.type || "application/octet-stream", name: f.name || "receipt" };
    }
    const receipt = await addManualReceipt({
      vendor, period, amountUsd: amount,
      itemId: String(form.get("itemId") || "") || undefined,
      chargedAt: String(form.get("chargedAt") || "") || undefined,
      invoiceNumber: String(form.get("invoiceNumber") || "") || undefined,
      description: String(form.get("description") || "") || undefined,
      notes: String(form.get("notes") || "") || undefined,
      file: filePart,
    });
    return ok({ receipt: publicReceipt(receipt) });
  }

  const b = await body<{ action?: string; monthsBack?: number; vendor?: string }>(req);
  if (b?.action === "harvest") {
    const res = startHarvest(Number(b.monthsBack) || 3);
    if (!res.started) return ok({ started: false, reason: res.reason, mailboxes: res.mailboxes });
    return ok({ started: true, mailboxes: res.mailboxes });
  }
  /* "Try again" from the console. Awaited rather than detached: the owner pressed it to find
     out whether it works now, so they get the answer, including the failure reason. */
  if (b?.action === "pullPortal") {
    const monthsBack = Number(b.monthsBack) || 3;
    const reports = b.vendor ? [await pullPortal(b.vendor, { monthsBack })] : await pullAllPortals(monthsBack);
    return ok({ pulls: reports });
  }
  return fail("unknown_action", 400);
}

export async function PATCH(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const b = await body<Partial<Receipt> & { id?: string }>(req);
  if (!b?.id) return fail("id_required", 400);
  const r = await updateReceipt(b.id, b);
  if (!r) return fail("not_found", 404);
  return ok({ receipt: publicReceipt(r) });
}

export async function DELETE(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("id_required", 400);
  if (!(await deleteReceipt(id))) return fail("not_found", 404);
  return ok({ deleted: true });
}
