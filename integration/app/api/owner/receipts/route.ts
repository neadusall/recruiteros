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
 *   POST   { action:"onePerCell" }          -> keep ONE receipt per vendor-month cell and
 *                                              drop the extras (owner presses it once; the
 *                                              rest are re-added by hand)
 *   POST   { action:"purgeJunk", dryRun? }  -> re-judge every email-harvested receipt under
 *                                              the strict classifier and take out the ones
 *                                              that were never receipts (also runs itself
 *                                              once, on the first GET after shipping)
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
  collapseToOnePerCell, purgeJunkEmail, purgeJunkEmailOnce, attachDocument,
  type Receipt,
} from "../../../../lib/owner/receipts";
import { buildSpendMatrix, sourcingStatus, withinRegister, REGISTER_START_MONTH } from "../../../../lib/owner/spendMatrix";
import { VENDOR_SOURCES } from "../../../../lib/owner/receiptSources";
import { receiptRouting } from "../../../../lib/owner/mailRoutes";
import { sentReceiptIds } from "../../../../lib/owner/portalSpend";
import { listFullAccounts } from "../../../../lib/owner";
import { listVault } from "../../../../lib/owner/vault";
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

  /* NOTE: the grid does NOT auto-collapse stacked cells. Two receipts filed for one vendor in
     one month are two charges until the owner says otherwise — merging them on page load
     silently destroyed the second one, so it was removed. Collapsing to one receipt per cell
     is now ONLY the explicit "Keep one receipt per cell" button (collapseToOnePerCell), a
     deliberate, confirmed press. */

  /* One-shot: the first grid load
     after the strict classifier shipped re-judges every email-harvested receipt under it
     and takes out the ones that were never receipts (job alerts as LinkedIn, Prime Day as
     AWS, deal blasts as TidyCal). Fingerprint-dismissed on the way out, so no sweep can
     refile them. */
  await purgeJunkEmailOnce().catch(() => {});

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

  /* The vault is the list of ACCOUNTS, and an account is the thing that has a mailbox
     behind it. It is read here rather than in the matrix because a locked or unreadable
     vault must not take the whole Spend master down with it: the routing panel is the
     only part that needs it, so a failure costs that panel and nothing else. */
  const routing = await listVault()
    .then((entries) => receiptRouting({ entries, mailboxes: boxes, receipts: allReceipts }))
    .catch(() => null);

  /* WHICH RECEIPTS ARE ALREADY ON THE CLIENT'S STATEMENT.
     The grid used to remember this only for the current page: a marker set in the browser
     when you pressed Send, gone the moment you reloaded. So after a refresh there was no
     way to tell what had gone over and what had not, and the safe-feeling move was to send
     the row again, which is exactly how the same invoice ends up on a client's bill twice.
     Read from the charge store instead, so it survives reloads, deploys and a different
     computer. OWNER-ONLY: this route answers 404 to anyone who is not the owner, so the
     accountant on the Lume side never sees any of it. */
  const accounts = (() => { try { return listFullAccounts(); } catch { return []; } })();
  const client = accounts.find((x) => /lumesp/i.test(x.domain || "") || /lume/i.test(x.name || "")) || accounts[0];
  const sent = client?.workspaceId
    ? { ...sentReceiptIds(client.workspaceId), client: client.name || "the client" }
    : { receiptIds: [], invoiceNumbers: [], client: "" };

  return ok({
    matrix,
    vault,
    sent,
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
    /* WHICH MAILBOX HOLDS WHICH VENDOR'S RECEIPTS. Built from the Passwords vault's
       per-account billing address joined to the mailboxes actually being swept, so a
       vendor billing an address nobody reads stops looking identical to one that never
       charged anything. Read from the FULL receipt list rather than the register-window
       one: whether a vendor has ever reported by email is a fact about the channel, and
       an older receipt still proves the channel works. */
    routing,
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

    /* ATTACHING TO A ROW THAT ALREADY EXISTS, rather than filing a new one beside it.
       Plenty of real charges are proven by their figure and have no picture: a plain-text
       confirmation, an invoice behind a login, a month pulled from a billing API that
       issues no document. Adding a second receipt for those made the same charge appear
       twice and pushed the coverage figure wrong in the other direction. */
    const attachTo = String(form.get("receiptId") || "").trim();
    if (attachTo) {
      if (!file || typeof file !== "object" || !("arrayBuffer" in file)) return fail("file_required", 400);
      const f = file as File;
      const bytes = Buffer.from(await f.arrayBuffer());
      if (!bytes.length) return fail("file_required", 400);
      if (bytes.length > 20 * 1024 * 1024) return fail("file_too_large", 413);
      const r = await attachDocument(attachTo, {
        bytes, mime: f.type || "application/octet-stream", name: f.name || "receipt",
      });
      if (!r.ok) return fail(r.error || "not_found", r.error === "not_found" ? 404 : 400);
      return ok({ receipt: publicReceipt(r.receipt as Receipt) });
    }

    const vendor = String(form.get("vendor") || "").trim();
    const period = String(form.get("period") || "").trim();
    const amount = Number(form.get("amountUsd"));
    if (!vendor) return fail("vendor_required", 400);
    if (!/^\d{4}-\d{2}$/.test(period)) return fail("period_required", 400);
    if (!Number.isFinite(amount)) return fail("amount_required", 400);
    /* ⚠️ ZERO IS NOT AN AMOUNT, IT IS AN UNFILLED FIELD. `Number.isFinite(0)` is true, so
       a blank box sailed through and filed a receipt that appears in the cell, bumps the
       count to "2 receipts", and moves the figure not at all. That reads as the grid
       failing to add up rather than as a form that was never completed, which is exactly
       how it was reported. A real charge is never $0; a refund is negative. */
    if (amount === 0) {
      return fail("amount_required", 422, {
        message: "Enter the amount on this invoice. A receipt for $0 would show in the cell without changing the total.",
      });
    }

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
  /* Collapse every vendor-month cell to one receipt, keeping the best copy and dropping the
     rest. Deliberate and destructive across genuinely separate charges too, so it is only
     ever this explicit press — the owner is left with a clean one-per-cell skeleton and adds
     any real second charge back by hand. */
  if (b?.action === "onePerCell") return ok(await collapseToOnePerCell());
  if (b?.action === "purgeJunk") return ok(await purgeJunkEmail({ dryRun: !!b.dryRun }));
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

/**
 * DELETE ?id=<id>          drop one receipt
 * DELETE ?ids=a,b,c        drop several, for clearing a whole row or a whole cell
 *
 * The list form takes explicit ids rather than a vendor or a row id, so the server never
 * has to decide what "this row" means. The grid already knows exactly which receipts it
 * is showing where — including the ones an account fold claims at report time, which no
 * server-side filter on vendor would reproduce — so it sends them, and a click can only
 * ever delete what the person was actually looking at.
 */
export async function DELETE(req: Request) {
  const g = requireOwner(req);
  if ("response" in g) return g.response;

  const p = new URL(req.url).searchParams;

  /**
   * ?vendor=<name> clears every receipt filed against one vendor, INCLUDING the ones the
   * grid cannot show.
   *
   * This exists because the id list cannot express the case that needed it. The grid is
   * filtered to the months the books cover, so a receipt dated outside that window is
   * invisible - and a GoDaddy row appeared with no receipts, no line item and no way to
   * act on it, driven entirely by four receipts dated 2024, 2025, 2027 and 2028. The two
   * future ones were expiry dates misread as charge dates. The browser could not delete
   * what it was never sent.
   *
   * Matched on the exact vendor name the grid shows, never a substring: "AWS" must not
   * take "AWS Marketplace" with it.
   */
  const vendor = (p.get("vendor") || "").trim();
  if (vendor) {
    const all = await listReceipts();
    const mine = all.filter((r) => r.vendor.trim().toLowerCase() === vendor.toLowerCase());
    if (!mine.length) return fail("not_found", 404);
    let n = 0;
    for (const r of mine) if (await deleteReceipt(r.id)) n++;
    return ok({ deleted: n, vendor });
  }

  const ids = [...(p.get("ids") || "").split(","), p.get("id") || ""]
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) return fail("id_required", 400);

  let deleted = 0;
  for (const id of [...new Set(ids)]) if (await deleteReceipt(id)) deleted++;
  // Nothing matched: the rows are already gone, which is worth saying rather than
  // reporting a success the page would not reflect.
  if (!deleted) return fail("not_found", 404);
  // A partial result is still a success: what existed is gone, and the page reloads from
  // the server anyway, so a stale id cannot leave the grid wrong.
  return ok({ deleted, missing: ids.length - deleted });
}
