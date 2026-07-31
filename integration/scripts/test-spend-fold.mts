/**
 * Month by month: one account, one line. Regression suite.
 * Run: npx tsx scripts/test-spend-fold.mts   (exits non-zero on failure)
 *
 * Pins the fold the owner asked for on 2026-07-31: "Zapmail, there is only one. Sure, on
 * the backend there are several accounts, but we are only being charged as one account.
 * In the month by month only do one fee, and with that there were two one-time receipts."
 *
 * The live register held 33 Zapmail lines (the Google Workspace mailboxes plus one line per
 * domain Zapmail registered), 30 Dynadot and 16 Porkbun. The rules that matter:
 *   - a vendor's domain lines fold into that vendor's account line, so the grid shows ONE
 *     row per account and the register keeps every domain for the Domains panel;
 *   - the money folds with them: expected figures, receipts and monthly equivalents;
 *   - a vendor with one domain, or none, is left exactly as it was;
 *   - a folded row carries a recurring fee AND one-time charges in the same month without
 *     that reading as a mismatch, a duplicate charge or a price rise;
 *   - a charge from a folded vendor that was never tied to a row lands on that one row
 *     instead of being reported as unregistered money, and is not counted twice.
 */

import { accountGroups, buildSpendMatrix } from "../lib/owner/spendMatrix";
import type { SpendItem } from "../lib/owner/spendRegister";
import type { Receipt } from "../lib/owner/receipts";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` (got ${g}, want ${w})`}`);
}

const T = "2026-07-01T00:00:00.000Z";
let seq = 0;
function item(vendor: string, label: string, over: Partial<SpendItem> = {}): SpendItem {
  return {
    id: `sp_${++seq}`, vendor, label, category: "email", billing: "monthly",
    amountUsd: 0, needsAmount: true, at: "2026-06-01", status: "active",
    seeded: true, createdAt: T, updatedAt: T,
    ...over,
  } as SpendItem;
}
function domain(vendor: string, name: string, over: Partial<SpendItem> = {}): SpendItem {
  return item(vendor, name, { category: "domain", billing: "annual", domain: name, ...over });
}
function receipt(vendor: string, period: string, amountUsd: number, over: Partial<Receipt> = {}): Receipt {
  return {
    id: `rc_${++seq}`, vendor, period, amountUsd, chargedAt: `${period}-15T00:00:00.000Z`,
    currency: "USD", kind: "charge", source: "manual", confidence: 1, hasShot: false,
    createdAt: T, updatedAt: T,
    ...over,
  } as Receipt;
}

/** The live shape: one Zapmail account line and the domains it registered. */
function zapmail(domains = 32): SpendItem[] {
  const mailboxes = item("Zapmail", "Google Workspace mailboxes", { at: "2026-07-01" });
  const names = Array.from({ length: domains }, (_, i) =>
    domain("Zapmail", `lumesearchgroup${i}.com`, { at: "2026-07-30" }));
  return [mailboxes, ...names];
}

/* 1. Thirty-three lines become one row, and it is the mailbox line that carries them. */
{
  const items = zapmail();
  const groups = accountGroups(items);
  check("33 Zapmail lines fold to 1 row", groups.length, 1);
  check("the account line hosts the fold", groups[0].display.label, "Google Workspace mailboxes");
  check("every line is still spoken for", groups[0].members.length, 33);
  check("the row says what it stands for", groups[0].label,
    "Google Workspace mailboxes · plus 32 names on the same account");
  check("the register itself is untouched", items.length, 33);
}

/* 2. A registrar with no separate account line still gets one row. */
{
  const groups = accountGroups([
    domain("Porkbun", "a.com"), domain("Porkbun", "b.com"), domain("Porkbun", "c.com"),
  ]);
  check("registrar with no account line folds anyway", groups.length, 1);
  check("and is named as an account", groups[0].label, "a.com · plus 3 names on the same account");
  check("with every domain inside it", groups[0].members.length, 3);
}

/* 3. The registrar's own "Domain registrations" line is preferred as the host. */
{
  const groups = accountGroups([
    item("Dynadot", "Domain registrations", { billing: "one_time", category: "domain" }),
    domain("Dynadot", "one.com"), domain("Dynadot", "two.com"),
  ]);
  check("the account line wins the fold", groups[0].display.label, "Domain registrations");
  check("named for what it is", groups[0].label, "Domain registrations · 2 names on one account");
}

/* 4. Nothing to fold is left alone. */
{
  const one = accountGroups([item("Namecheap", "Domain registrations"), domain("Namecheap", "glassnwa.com")]);
  check("a single domain does not fold", one.length, 2);
  check("and keeps its own name", one[1].label, "glassnwa.com");
  const none = accountGroups([item("Telnyx", "SMS and voice"), item("Hetzner", "Servers (all boxes)")]);
  check("vendors with no domains are untouched", none.map((g) => g.label), ["SMS and voice", "Servers (all boxes)"]);
  check("and are not marked as folded", none.every((g) => !g.folded), true);
}

/* 5. Vendors do not bleed into each other. */
{
  const groups = accountGroups([
    ...zapmail(3),
    item("Dynadot", "Domain registrations"), domain("Dynadot", "x.com"), domain("Dynadot", "y.com"),
  ]);
  check("one row per vendor", groups.length, 2);
  check("Zapmail keeps its own", groups[0].members.length, 4);
  check("Dynadot keeps its own", groups[1].members.length, 3);
}

/* 6. The money folds with the lines: one row, one running total. */
{
  const mailboxes = item("Zapmail", "Google Workspace mailboxes",
    { amountUsd: 120, needsAmount: false, at: "2026-06-01" });
  const names = [
    domain("Zapmail", "a.com", { amountUsd: 11, needsAmount: false, at: "2026-06-01" }),
    domain("Zapmail", "b.com", { amountUsd: 9, needsAmount: false, at: "2026-06-01" }),
  ];
  const m = buildSpendMatrix([mailboxes, ...names], [], { months: 3, inboxConfigured: true });
  const row = m.rows.filter((r) => r.vendor === "Zapmail")[0];
  check("one Zapmail row in the grid", m.rows.filter((r) => r.vendor === "Zapmail").length, 1);
  check("the fold is declared", row.foldedCount, 3);
  check("the monthly figure is the whole account", row.monthlyUsd, 121.67);
  const june = row.cells.filter((c) => c.period === "2026-06")[0];
  check("the anniversary month expects fee plus renewals", june.expectedUsd, 140);
  const july = row.cells.filter((c) => c.period === "2026-07")[0];
  check("an ordinary month expects the fee alone", july.expectedUsd, 120);
}

/* 7. A fee and a one-time buy in one month is an account, not a billing error. */
{
  const mailboxes = item("Zapmail", "Google Workspace mailboxes",
    { amountUsd: 120, needsAmount: false, at: "2026-06-01" });
  const names = [domain("Zapmail", "a.com"), domain("Zapmail", "b.com")];
  const receipts = [
    receipt("Zapmail", "2026-06", 120, { itemId: mailboxes.id }),
    receipt("Zapmail", "2026-07", 120, { itemId: mailboxes.id }),
    receipt("Zapmail", "2026-07", 348, { itemId: mailboxes.id }),
  ];
  const m = buildSpendMatrix([mailboxes, ...names], receipts, { months: 3, inboxConfigured: true });
  const row = m.rows.filter((r) => r.vendor === "Zapmail")[0];
  const july = row.cells.filter((c) => c.period === "2026-07")[0];
  check("the month is paid, not a mismatch", july.status, "paid");
  check("and it says which part was one-time", july.note,
    "$120.00 recurring plus $348.00 one-time on the same account");
  check("both receipts are on the cell", july.receipts.length, 2);
  check("no duplicate-charge flag on an account row",
    m.anomalies.filter((a) => a.kind === "duplicate_charge").length, 0);
  check("and no invented price rise",
    m.anomalies.filter((a) => a.kind === "price_change").length, 0);
}

/* 8. An untied charge from a folded vendor lands on the one row it can belong to. */
{
  const items = zapmail(2);
  const receipts = [receipt("Zapmail", "2026-07", 79)];
  const m = buildSpendMatrix(items, receipts, { months: 2, inboxConfigured: true });
  const row = m.rows.filter((r) => r.vendor === "Zapmail")[0];
  check("the charge lands on the account row", row.receiptCount, 1);
  check("it is not reported as unregistered money", m.unmatched.length, 0);
  check("and it is counted exactly once", m.totals.allTimeCountedUsd, 79);
  check("no 'not on the register' row for it",
    m.rows.filter((r) => r.unregistered).length, 0);
}

/* 9. A charge from a vendor with no register line at all is still reported. */
{
  const m = buildSpendMatrix(zapmail(2), [receipt("Stripe", "2026-07", 42)], { months: 2, inboxConfigured: true });
  check("unknown vendors still surface", m.unmatched.map((u) => u.vendor), ["Stripe"]);
  check("with a row of their own", m.rows.filter((r) => r.unregistered).length, 1);
}

/* 10. Receipts on a folded domain line are the account's receipts. */
{
  const items = zapmail(2);
  const m = buildSpendMatrix(items, [receipt("Zapmail", "2026-07", 25, { itemId: items[2].id })], {
    months: 2, inboxConfigured: true,
  });
  const row = m.rows.filter((r) => r.vendor === "Zapmail")[0];
  check("a domain-line receipt shows on the account row", row.receiptCount, 1);
  check("and is proven money", row.totalVerifiedUsd, 25);
}

/* 11. Priced receipts against an unpriced row ask for the price, once, and nothing else. */
{
  const items = zapmail(2);
  const m = buildSpendMatrix(items, [receipt("Zapmail", "2026-07", 79)], { months: 2, inboxConfigured: true });
  const kinds = m.anomalies.filter((a) => a.vendor === "Zapmail").map((a) => a.kind);
  check("no surprise-charge noise on an unpriced row", kinds.filter((k) => k === "unexpected_charge").length, 0);
  check("just the one ask", kinds.filter((k) => k === "no_price_on_file").length, 1);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
