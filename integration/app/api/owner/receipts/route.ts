/**
 * /api/owner/receipts  (OWNER ONLY)
 *
 * The receipt vault behind Owner Console -> Spend master -> "Month by month". Every dollar
 * with the invoice that proves it, laid out per service per month with a running total.
 *
 *   GET    ?months=12          -> the reconciled matrix, the per-vendor sourcing status,
 *                                 the anomaly list, and the state of the billing mailbox
 *   POST   { action:"harvest", monthsBack } -> sweep the mailbox (detached; poll the GET)
 *   POST   { action:"render", force? }      -> re-render every receipt whose document is on
 *                                              disk but whose picture is missing
 *   POST   { action:"relink", dryRun? }     -> put every charge on the register line it
 *                                              paid for, and drop any copy of a charge
 *                                              already on file
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
  pullerStates, lastPullerReportAt, renderMissingShots, repairVault, vaultHealth,
  type Receipt,
} from "../../../../lib/owner/receipts";
import { buildSpendMatrix, sourcingStatus, withinRegister, REGISTER_START_MONTH } from "../../../../lib/owner/spendMatrix";
import { VENDOR_SOURCES } from "../../../../lib/owner/receiptSources";
import { ensureVendorUsageReady } from "../../../../lib/owner/vendorUsage";
import { closeHistory, monthToClose, ensureCloseReady } from "../../../../lib/owner/monthClose";
import { noticeConfigured } from "../../../../lib/owner/ownerNotice";
import { ownerEmails } from "../../../../lib/owner/emails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/* Re-rendering a backlog of receipts is a Chromium launch each, so this is minutes. */
export const maxDuration = 900;

export async function GET(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;
  const months = Number(new URL(req.url).searchParams.get("months")) || 12;

  /* The vendor-billed figures are read synchronously while the grid is built, so the store
     has to be hydrated before that: on a cold container the first page view would otherwise
     price every metered line off the internal ledger and look wrong exactly once. */
  const [items, allReceipts] = await Promise.all([listSpendItems(), listReceipts(), ensureVendorUsageReady()]);
  /* The books begin at REGISTER_START_MONTH. Older charges stay in the vault (nothing is
     deleted, and the sweep still stores what it finds) but they are not reported here, so
     the grid, the gallery and the per-vendor counts all cover the same period. */
  const receipts = allReceipts.filter(withinRegister);
  const boxes = billingMailboxes();
  const matrix = buildSpendMatrix(items, receipts, { months, inboxConfigured: boxes.length > 0 });

  const pullers = pullerStates();
  /* Whether every charge is on its own line and nothing is filed twice. Read-only: it
     reports what a repair WOULD do, so the console can offer the fix without a page view
     ever quietly rewriting the books. */
  const vault = await vaultHealth().catch(() => ({ unlinked: 0, duplicates: 0, linkable: 0 }));

  /* Whether the books are closing themselves. Without this the page can say a month is
     short but not whether anything is WATCHING for that, which is the difference between
     a dashboard and something you can stop checking. */
  await ensureCloseReady();

  return ok({
    matrix,
    vault,
    close: {
      /* The verdict per month, newest first: what the unattended job decided and when. */
      history: closeHistory().slice(0, 6),
      /* The month it is judging now, or null while the new one is still inside its grace
         window and nothing can fairly be called missing yet. */
      judging: monthToClose(),
      /* Whether a verdict can actually reach anyone. A checker that cannot report is just
         a log file. */
      notice: { configured: noticeConfigured(), to: ownerEmails() },
    },
    /* The month the books open on, so the page can say where it starts rather than
       leaving an accountant to wonder what happened to the months before it. */
    registerStart: REGISTER_START_MONTH,
    sourcing: sourcingStatus(items, receipts, pullers),
    /* The browser sessions that fetch invoices the vendors never email. Reported
       separately from the per-vendor rows so the console can say plainly when the
       sweep itself has stopped running, which no single vendor row can show. */
    pullers: { lastReportAt: lastPullerReportAt(), count: pullers.length, states: pullers },
    /* EVERY receipt, newest first: the console's receipt gallery is a complete record of
       what has been paid, not a recent-activity feed. Metadata only, so this stays small
       however many there are; the images are fetched per receipt. */
    receipts: receipts.slice(0, 500).map(publicReceipt),
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

  const b = await body<{ action?: string; monthsBack?: number; force?: boolean; dryRun?: boolean }>(req);
  if (b?.action === "harvest") {
    const res = startHarvest(Number(b.monthsBack) || 3);
    if (!res.started) return ok({ started: false, reason: res.reason, mailboxes: res.mailboxes });
    return ok({ started: true, mailboxes: res.mailboxes });
  }
  /* Put the picture back on rows that already have the document. The nightly tick does this
     on its own; the button is for the owner who is looking at "no image" right now. */
  if (b?.action === "render") return ok({ shots: await renderMissingShots({ force: !!b.force }) });
  /* Split a vendor's charges onto the individual lines they paid for, and drop any copy of
     a charge already on file. The nightly tick does this too; the button is for the owner
     looking at one merged block right now. */
  if (b?.action === "relink") return ok({ vault: await repairVault({ dryRun: !!b.dryRun }) });
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
