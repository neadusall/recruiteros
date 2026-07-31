/**
 * The month closes itself: regression suite.
 * Run: npx tsx scripts/test-month-close.mts   (exits non-zero on failure)
 *
 * This job runs unattended and decides whether to interrupt a person. Both failure modes
 * are bad in different ways, so both are pinned here:
 *
 *   silent when it should speak   a lapsed browser session, a refused mailbox, a month with
 *                                 no paperwork: the whole reason the job exists.
 *   speaks when it should not     an alert that arrives every morning gets filtered within
 *                                 a week, and a filtered alert is worse than none because
 *                                 it looks like cover while providing none.
 *
 * The fixture is the real shape of the books on 2026-07-31: RapidAPI billing five listings
 * separately, one vendor collected by a browser session, one by a billing API.
 */

import {
  assessMonth, assessCollectors, shouldReport, monthToClose, monthReport, settledReport, collectorReport,
} from "../lib/owner/monthClose";
import type { SpendMatrix, SourcingRow, MatrixRow, MatrixCell } from "../lib/owner/spendMatrix";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` (got ${g}, want ${w})`}`);
}
function checkTrue(name: string, got: boolean): void { check(name, got, true); }

/* ============================ fixtures ============================ */

function cell(o: Partial<MatrixCell> & { period: string; status: MatrixCell["status"] }): MatrixCell {
  return {
    actualUsd: 0, meteredUsd: 0, expectedUsd: 0, countedUsd: 0, verified: false,
    runningUsd: 0, deltaUsd: null, receipts: [], ...o,
  };
}

function row(vendor: string, label: string, cells: MatrixCell[], extra: Partial<MatrixRow> = {}): MatrixRow {
  return {
    vendor, label, category: "search", billing: "monthly", status: "active", monthlyUsd: 0,
    emailProven: false, cells, totalCountedUsd: 0, totalVerifiedUsd: 0, receiptCount: 0,
    missingCount: 0, ...extra,
  };
}

function matrixOf(rows: MatrixRow[]): SpendMatrix {
  return {
    months: ["2026-06", "2026-07"], rows, monthTotals: [], unmatched: [], anomalies: [],
    totals: {
      allTimeCountedUsd: 0, allTimeVerifiedUsd: 0, receiptCount: 0, missingCount: 0,
      coveragePct: 0, currentMonthUsd: 0, priorMonthUsd: 0, avgMonthUsd: 0,
    },
  };
}

function src(vendor: string, state: SourcingRow["state"], extra: Partial<SourcingRow> = {}): SourcingRow {
  return {
    vendor, channel: "portal_only", from: [], emailCount: 0, manualCount: 0, apiCount: 0,
    portalCount: 0, state, advice: `advice for ${vendor}`, ...extra,
  };
}

const PAID = (period: string, amt: number) => cell({ period, status: "paid", expectedUsd: amt, actualUsd: amt, countedUsd: amt, verified: true });
const MISSING = (period: string, amt: number) => cell({ period, status: "missing", expectedUsd: amt });

/* ============================ a month that is fine ============================ */
{
  const m = matrixOf([
    row("RapidAPI", "JSearch (Ultra)", [PAID("2026-07", 75)]),
    row("RapidAPI", "Skip Tracing Working API", [PAID("2026-07", 60)]),
  ]);
  const close = assessMonth("2026-07", m, [src("RapidAPI", "portal", { portalCount: 2 })]);
  check("a fully receipted month is settled", close.state, "settled");
  check("...with no gaps", close.gaps.length, 0);
  check("...and 100% proven", close.coveragePct, 100);
  check("...and its digest says so", close.digest, "settled");
  checkTrue("nothing is reported for it", !shouldReport(undefined, close.digest, new Date()).report);
}

/* ============================ a month that is short ============================ */
{
  const m = matrixOf([
    row("RapidAPI", "JSearch (Ultra)", [PAID("2026-07", 75)]),
    row("Hetzner", "Servers (all boxes)", [MISSING("2026-07", 71)]),
  ]);
  const working = [src("RapidAPI", "portal", { portalCount: 1 }), src("Hetzner", "auto", { emailCount: 3 })];
  const close = assessMonth("2026-07", m, working);
  check("a month with an uncollected charge is short", close.state, "short");
  check("...naming the vendor", close.gaps.map((g) => g.vendor), ["Hetzner"]);
  check("...and the money", close.gaps[0]?.expectedUsd, 71);
  check("...proven share excludes it", close.coveragePct, 51);
  checkTrue("it is reported the first time", shouldReport(undefined, close.digest, new Date()).report);
}

/* ============================ short BECAUSE nothing is collecting ============================ */
{
  const m = matrixOf([row("Smartlead", "Inbox warm-up", [MISSING("2026-07", 174)])]);
  const close = assessMonth("2026-07", m, [
    src("Smartlead", "portal_unset", { advice: "Nothing is collecting this vendor's receipt. Run node receipts.mjs login smartlead" }),
  ]);
  check("a gap nobody is collecting reads blocked, not short", close.state, "blocked");
  checkTrue("...and the gap says so", close.gaps[0].blocked);
  checkTrue("...carrying the fix", close.gaps[0].action?.includes("login smartlead") === true);
  checkTrue("the subject says nothing is collecting", monthReport(close).subject.includes("nothing is collecting"));
  checkTrue("the body names the money", monthReport(close).body.includes("$174"));
}

/* ============================ a stalled puller is blocked, not short ============================ */
{
  const m = matrixOf([row("RapidAPI", "JSearch (Ultra)", [MISSING("2026-07", 75)])]);
  const close = assessMonth("2026-07", m, [
    src("RapidAPI", "portal", {
      portalCount: 8,
      puller: { ready: true, route: "portal", state: "ok", ranDaysAgo: 21, stalled: true, action: "the sweep has not run for 21 days" },
    }),
  ]);
  check("a sweep that stopped running is a blocked month", close.state, "blocked");
}

/* ============================ a dead mailbox blocks everything ============================ */
{
  const m = matrixOf([row("Hetzner", "Servers (all boxes)", [MISSING("2026-07", 71)])]);
  const close = assessMonth("2026-07", m, [src("Hetzner", "auto", { emailCount: 3 })], {
    mailboxError: "rrnead@gmail.com refused the sign-in (Invalid credentials)",
  });
  check("a refused mailbox blocks the month", close.state, "blocked");
  checkTrue("...and the email says which mailbox", monthReport(close).body.includes("rrnead@gmail.com"));
}

/* ============================ a row with no price is not chased ============================ */
{
  const m = matrixOf([row("Apify", "Direct-dial phone actor", [MISSING("2026-07", 0)], { needsAmount: true })]);
  const close = assessMonth("2026-07", m, [src("Apify", "unproven")]);
  check("a row with no price on file is not a missing receipt", close.state, "settled");
}

/* ============================ not saying the same thing twice ============================ */
{
  const now = new Date("2026-08-04T06:00:00Z");
  const said = { digest: "2:abc", at: "2026-08-04T05:00:00Z", count: 1 };
  check("an unchanged picture is not re-reported", shouldReport(said, "2:abc", now).report, false);
  check("...but a changed one is", shouldReport(said, "3:xyz", now).report, true);
  check("...and an unchanged one is repeated after a week",
    shouldReport({ ...said, at: "2026-07-26T05:00:00Z" }, "2:abc", now).report, true);
  check("a settled month is never reported as a problem", shouldReport(undefined, "settled", now).report, false);
  check("healthy collectors are never reported", shouldReport(undefined, "ok", now).report, false);
}

/* ============================ which month, and when ============================ */
{
  check("the 1st is too early to judge last month", monthToClose(new Date("2026-08-01T06:00:00Z")), null);
  check("the 3rd is still inside the grace window", monthToClose(new Date("2026-08-03T06:00:00Z")), null);
  check("the 4th closes July", monthToClose(new Date("2026-08-04T06:00:00Z")), "2026-07");
  check("January closes the December before it", monthToClose(new Date("2027-01-09T06:00:00Z")), "2026-12");
}

/* ============================ the mid-month early warning ============================ */
{
  const healthy = assessCollectors([
    src("Telnyx", "api", { apiCount: 10 }),
    src("RapidAPI", "portal", { portalCount: 8, puller: { ready: true, route: "portal", state: "ok", ranDaysAgo: 1, stalled: false } }),
  ]);
  checkTrue("a working setup is collecting", healthy.collecting);
  check("...and says nothing", healthy.digest, "ok");

  const broken = assessCollectors([
    src("Telnyx", "api", { apiCount: 10 }),
    src("Smartlead", "portal_unset", { advice: "sign in once" }),
  ]);
  check("a vendor nobody collects is named", broken.blockedVendors.map((b) => b.vendor), ["Smartlead"]);
  checkTrue("...and that is worth an email", shouldReport(undefined, broken.digest, new Date()).report);
  checkTrue("...whose body carries the fix", collectorReport(broken).body.includes("sign in once"));

  const deadBox = assessCollectors([src("Hetzner", "auto", { emailCount: 3 })], { mailboxError: "refused the sign-in" });
  checkTrue("a dead mailbox means nothing is collecting", !deadBox.collecting);
  checkTrue("...and leads the subject", collectorReport(deadBox).subject.includes("billing mailbox"));
}

/* ============================ the all-clear ============================ */
{
  const close = assessMonth("2026-07", matrixOf([row("RapidAPI", "JSearch (Ultra)", [PAID("2026-07", 75)])]), [src("RapidAPI", "portal")]);
  const mail = settledReport(close);
  checkTrue("the all-clear names the month", mail.subject.includes("July 2026"));
  checkTrue("...and says nothing needs doing", mail.body.includes("Nothing needs doing"));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
