/**
 * Spend register seed-merge: regression suite.
 * Run: npx tsx scripts/test-spend-merge.mts   (exits non-zero on failure)
 *
 * Pins the fold that turns the three per-box Hetzner rows into ONE server-cost line
 * (owner decision 2026-07-31, "that is just server cost"). The rules that matter:
 *   - the three old rows disappear and only the merged row is left;
 *   - money the owner had already entered is carried forward, never dropped;
 *   - a figure already sitting on the merged row wins over anything folded in;
 *   - the merged row is only "verified" if every priced row folded in was;
 *   - the spend is dated from the FIRST box bought, not the last;
 *   - with no merged row present (seed never applied) nothing is deleted.
 * Also pins the retirement rule (owner, 2026-07-31): fourteen vendors come OFF the register
 * entirely - the ones we do not use, the ones we use but are not billed for here, and the
 * ones that cost this book nothing at all (down to the Reoon licence bought outright years
 * ago) - and a row is only dropped while it still carries no owner-entered money.
 * The suite calls mergeSeedRows with its real shipped merge list, so a change to which
 * rows are folded shows up here.
 */

import { mergeSeedRows, retireSeedRows, type SpendItem } from "../lib/owner/spendRegister";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` (got ${g}, want ${w})`}`);
}

const T = "2026-07-01T00:00:00.000Z";
function row(vendor: string, label: string, over: Partial<SpendItem> = {}): SpendItem {
  return {
    id: "sp_" + label.replace(/\W+/g, "").slice(0, 12),
    vendor, label, category: "infra", billing: "monthly",
    amountUsd: 0, needsAmount: true, at: "2026-06-02", status: "active",
    seeded: true, createdAt: T, updatedAt: T,
    ...over,
  };
}

const MERGED = "Servers (all boxes)";
const APP = "App server (ubuntu-8gb-ash-1, CCX13)";
const WORKER = "Sourcing worker (recruiteros-worker-2, CPX11)";
const FLEET = "Scraper fleet (5 boxes)";

function hetzner(items: SpendItem[]): SpendItem[] {
  return items.filter((i) => i.vendor === "Hetzner");
}

/* 1. The live shape on the box: three unpriced boxes plus the row the seed just added. */
{
  const out = mergeSeedRows([
    row("Hetzner", APP),
    row("Hetzner", WORKER),
    row("Hetzner", FLEET, { at: "2026-06-10" }),
    row("Hetzner", MERGED),
    row("RackNerd", "Mailcow mail server (8GB)"),
  ]);
  check("three boxes fold to one row", hetzner(out).map((i) => i.label), [MERGED]);
  check("other vendors untouched", out.length, 2);
  check("still asking for the amount", [hetzner(out)[0].amountUsd, hetzner(out)[0].needsAmount], [0, true]);
  check("dated from the first box bought", hetzner(out)[0].at, "2026-06-02");
}

/* 2. Figures the owner typed are carried forward as their total, not lost. */
{
  const out = mergeSeedRows([
    row("Hetzner", APP, { amountUsd: 23.45, needsAmount: false, verified: true }),
    row("Hetzner", WORKER, { amountUsd: 4.35, needsAmount: false, verified: true }),
    row("Hetzner", FLEET, { amountUsd: 19.2, needsAmount: false, verified: true, at: "2026-05-20" }),
    row("Hetzner", MERGED),
  ]);
  check("priced rows sum into the merged row", hetzner(out)[0].amountUsd, 47);
  check("no longer needs an amount", hetzner(out)[0].needsAmount, false);
  check("stays verified when every part was", hetzner(out)[0].verified, true);
  check("takes the earliest start date", hetzner(out)[0].at, "2026-05-20");
}

/* 3. One unproven figure makes the total unproven. */
{
  const out = mergeSeedRows([
    row("Hetzner", APP, { amountUsd: 23.45, verified: true }),
    row("Hetzner", WORKER, { amountUsd: 4.35, verified: false }),
    row("Hetzner", MERGED),
  ]);
  check("total is only as proven as its parts", [hetzner(out)[0].amountUsd, hetzner(out)[0].verified], [27.8, false]);
}

/* 4. An amount already on the merged row is the owner's, and wins. */
{
  const out = mergeSeedRows([
    row("Hetzner", APP, { amountUsd: 23.45, verified: true }),
    row("Hetzner", MERGED, { amountUsd: 61, needsAmount: false, verified: true }),
  ]);
  check("owner figure on the merged row survives", hetzner(out)[0].amountUsd, 61);
  check("the old row is still folded away", hetzner(out).length, 1);
}

/* 5. Every box cancelled means the merged line is cancelled too. */
{
  const out = mergeSeedRows([
    row("Hetzner", APP, { status: "cancelled" }),
    row("Hetzner", WORKER, { status: "cancelled" }),
    row("Hetzner", FLEET, { status: "cancelled" }),
    row("Hetzner", MERGED),
  ]);
  check("all cancelled folds to cancelled", hetzner(out)[0].status, "cancelled");
}
{
  const out = mergeSeedRows([
    row("Hetzner", APP, { status: "cancelled" }),
    row("Hetzner", WORKER),
    row("Hetzner", MERGED),
  ]);
  check("one live box keeps the line active", hetzner(out)[0].status, "active");
}

/* 6. Without the merged row nothing is deleted: a fold must never lose a line. */
{
  const out = mergeSeedRows([row("Hetzner", APP), row("Hetzner", WORKER), row("Hetzner", FLEET)]);
  check("no target means no deletions", hetzner(out).map((i) => i.label), [APP, WORKER, FLEET]);
}

/* 7. Re-running is a no-op: the fold survives every redeploy that re-hydrates the store. */
{
  const once = mergeSeedRows([row("Hetzner", APP, { amountUsd: 30, verified: true }), row("Hetzner", MERGED)]);
  const twice = mergeSeedRows(once);
  check("second pass changes nothing", twice.map((i) => [i.label, i.amountUsd]), [[MERGED, 30]]);
}

/* 8. Retirement: rows the register should not carry are dropped, but only while they are
      still exactly as the seed left them. */
{
  const out = retireSeedRows([
    row("Instantly", "Outreach sending (alternate provider)"),
    row("Loxo", "ATS seats"),
    row("TidyCal", "Booking links"),
    row("GitHub", "Repositories"),
    row("GoDaddy", "Domain registrations"),
    row("Telnyx", "SMS and voice"),
  ]);
  check("retired seed rows are dropped", out.map((i) => i.vendor), ["Telnyx"]);
}
{
  // The lifetime Reoon licence and People Data Labs, retired the same day: neither can
  // ever post a charge to this book, so a $0 line for either is noise.
  const out = retireSeedRows([
    row("Reoon", "Email verifier", { billing: "one_time", lifetime: true, needsAmount: false }),
    row("People Data Labs", "Person enrichment"),
    row("Icypeas", "Email finding and verification"),
  ]);
  check("lifetime and unbilled rows are dropped", out.map((i) => i.vendor), ["Icypeas"]);
}
{
  // Other registrars share GoDaddy's label, so the retirement must match on vendor too.
  const out = retireSeedRows([
    row("Porkbun", "Domain registrations"),
    row("Namecheap", "Domain registrations"),
    row("Dynadot", "Domain registrations"),
  ]);
  check("registrars sharing the label are kept", out.map((i) => i.vendor), ["Porkbun", "Namecheap", "Dynadot"]);
}
{
  const out = retireSeedRows([
    row("Loxo", "ATS seats", { amountUsd: 119, needsAmount: false }),
    row("KoldInfo", "People and business email database", { verified: true }),
    row("Laxis", "Contact enrichment", { seeded: false }),
  ]);
  check("a priced, proven or owner-added row is never deleted", out.length, 3);
}
{
  const once = retireSeedRows([row("Hume", "Empathic voice"), row("Telnyx", "SMS and voice")]);
  check("second pass changes nothing", retireSeedRows(once).map((i) => i.vendor), ["Telnyx"]);
}
{
  check("a vendor not on the list is untouched", retireSeedRows([row("Loxo", "Something else")]).length, 1);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
