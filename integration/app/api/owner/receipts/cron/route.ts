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
import { harvestAll, listReceipts } from "../../../../../lib/owner/receipts";
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
  const monthsBack = Math.max(1, Math.min(24, Number(url.searchParams.get("monthsBack")) || 3));
  const wait = url.searchParams.get("wait") !== "0";
  /* Vendors with a real billing API are pulled on every tick: an API cannot be filtered
     into spam or deleted, so those months report themselves even if no mail arrives. */
  const withVendors = url.searchParams.get("vendors") !== "0";

  const pulls = withVendors ? await pullVendorApis(monthsBack).catch(() => []) : [];

  if (!wait) {
    const { startHarvest } = await import("../../../../../lib/owner/receipts");
    return NextResponse.json({ ok: true, pulls, ...startHarvest(monthsBack) });
  }

  const result = await harvestAll(monthsBack);
  const [items, receipts] = await Promise.all([listSpendItems(), listReceipts()]);
  const matrix = buildSpendMatrix(items, receipts, { months: Math.max(6, monthsBack), inboxConfigured: true });

  return NextResponse.json({
    ok: result.ok || pulls.some((p) => p.ok),
    reason: result.reason,
    pulls,
    reports: result.reports,
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
