/**
 * POST or GET /api/owner/receipts/cron?monthsBack=3[&wait=0]
 *
 * The scheduled half of the receipt vault. A button someone has to remember to press
 * cannot guarantee that a month gets reported; a nightly tick can. Each run re-reads the
 * billing mailbox over the trailing window and imports anything new — the sweep is
 * read-only and de-duplicates on the message itself, so running it every day is free of
 * consequence and self-healing when a receipt arrives late.
 *
 * Auth: shared secret via x-cron-secret header or ?secret= (RECRUITEROS_CRON_SECRET),
 * matching /api/sending/cron and /api/linkedin/cron.
 *
 * Returns the sweep report per mailbox plus what the books look like afterwards, so a
 * scheduler log is enough to see that last month is fully receipted.
 */

import { NextResponse } from "next/server";
import { requireCronAuth } from "../../../../../lib/linkedin/auth";
import { harvestAll, listReceipts, renderMissingShots, repairVault } from "../../../../../lib/owner/receipts";
import { listSpendItems } from "../../../../../lib/owner/spendRegister";
import { buildSpendMatrix } from "../../../../../lib/owner/spendMatrix";
import { pullVendorApis } from "../../../../../lib/owner/vendorPullers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/* A full sweep renders a screenshot per receipt, so it is minutes, not seconds. */
export const maxDuration = 900;

async function run(req: Request) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  let monthsBack = Math.max(1, Math.min(24, Number(url.searchParams.get("monthsBack")) || 3));
  /* Once a month, sweep a full year instead of the trailing three. An annual renewal posts
     once and a one-time domain buy never repeats, so both fall outside a 3-month nightly
     window and would never be caught by the scheduled sweep at all — only by someone
     remembering to widen the look-back by hand. Doing it automatically in the first days of
     the month closes that: the sweep is read-only and de-duplicates on the message, so the
     wide pass only renders receipts it has never seen and is free to repeat. Skipped when the
     caller named an explicit window (a manual backfill is already saying how far to look). */
  if (!url.searchParams.get("monthsBack") && new Date().getUTCDate() <= 3) {
    monthsBack = Math.max(monthsBack, 13);
  }
  const wait = url.searchParams.get("wait") !== "0";
  /* Vendors with a real billing API are pulled on every tick: an API cannot be filtered
     into spam or deleted, so those months report themselves even if no mail arrives. */
  const withVendors = url.searchParams.get("vendors") !== "0";
  /* force=1 re-sums closed months that are already on file: the repair path after a puller
     bug, never the default, because a settled month should not be recomputed nightly. */
  const force = url.searchParams.get("force") === "1";

  /* Take out charges harvested from a mailbox that are not this company's: a personal
     mailbox files personal spending, and it was in the books before the relevance filter
     existed. `dryRun` is the DEFAULT so a mistyped call reports instead of deleting;
     &purgeNotOurs=apply is the deliberate one. Nothing else on this tick is destructive,
     which is why this asks for a word rather than a flag. */
  const purge = url.searchParams.get("purgeNotOurs");
  if (purge) {
    const { purgeNotOurs } = await import("../../../../../lib/owner/receipts");
    const r = await purgeNotOurs({ dryRun: purge !== "apply" });
    return NextResponse.json({ ok: true, dryRun: purge !== "apply", ...r });
  }

  const pulls = withVendors ? await pullVendorApis(monthsBack, { force }).catch(() => []) : [];

  if (!wait) {
    const { startHarvest } = await import("../../../../../lib/owner/receipts");
    return NextResponse.json({ ok: true, pulls, ...startHarvest(monthsBack) });
  }

  const result = await harvestAll(monthsBack);

  /* Put every charge on the line it actually paid for, and take out any copy of a charge
     already on file. A vendor that bills several listings separately (RapidAPI bills five)
     produces one receipt per listing, and each belongs against its own register row rather
     than in a single undifferentiated block under the vendor's name. Cheap: no browser, no
     network, just the vault against the register. */
  const vault = await repairVault().catch(() => null);

  /* Then give every receipt back the picture of its own document. A render can fail long
     after the document is safely filed, and until this ran nothing ever went back for it:
     the row said "no image" forever with the vendor's invoice sitting on disk beside it. */
  const shots = await renderMissingShots().catch((e) => ({
    checked: 0, rendered: 0, alreadyOk: 0, noSource: 0, failed: 0,
    failures: [{ id: "-", vendor: "-", period: "-", error: (e as Error)?.message || "repair failed" }],
  }));

  const [items, receipts] = await Promise.all([listSpendItems(), listReceipts()]);
  const matrix = buildSpendMatrix(items, receipts, { months: Math.max(6, monthsBack), inboxConfigured: true });

  return NextResponse.json({
    ok: result.ok || pulls.some((p) => p.ok),
    reason: result.reason,
    pulls,
    reports: result.reports,
    vault,
    shots,
    books: {
      months: matrix.months,
      monthTotals: matrix.monthTotals.map((m) => ({
        period: m.period, counted: m.countedUsd, proven: m.verifiedUsd,
        coveragePct: m.coveragePct, missing: m.missingCount,
      })),
      receipts: matrix.totals.receiptCount,
      coveragePct: matrix.totals.coveragePct,
      /* The reason this endpoint exists: months that are still not fully reported. */
      gaps: matrix.anomalies
        .filter((a) => a.kind === "missing_receipt" || a.kind === "never_receipted")
        .map((a) => a.message),
    },
  });
}

export const GET = run;
export const POST = run;
