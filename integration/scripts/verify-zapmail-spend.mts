/**
 * What Spend master will actually say about Zapmail after this change.
 *
 * Run against a COPY of the live /data snapshots, so the real books are never
 * touched: the seed migration runs, the correction lands, and the answer is the
 * same payload the console reads.
 *
 *   ROS_DATA_DIR=<copy of /data> npx tsx scripts/verify-zapmail-spend.mts
 */

import { listSpendItems, attachLive, rollupBurn } from "../lib/owner/spendRegister";
import { listReceipts, repairVault } from "../lib/owner/receipts";
import { buildSpendMatrix } from "../lib/owner/spendMatrix";

const money = (n: number) => `$${(Math.round((n || 0) * 100) / 100).toFixed(2)}`;

const items = await listSpendItems();
const zap = items.filter((i) => i.vendor === "Zapmail");
const plan = zap.find((i) => !i.domain);

console.log(`register: ${items.length} rows, ${zap.length} of them Zapmail\n`);
console.log("the mailbox plan row");
console.log(`  billing      ${plan?.billing}`);
console.log(`  amount       ${money(plan?.amountUsd ?? 0)}`);
console.log(`  verified     ${plan?.verified === true}`);
console.log(`  needsAmount  ${plan?.needsAmount === true}`);

const domains = zap.filter((i) => i.domain);
const domainMoney = domains.reduce((t, d) => t + (d.amountUsd || 0), 0);
console.log(`\nthe ${domains.length} domain rows (one-off money, deliberately separate)`);
console.log(`  billing kinds  ${JSON.stringify(domains.reduce<Record<string, number>>((m, d) => { m[d.billing] = (m[d.billing] || 0) + 1; return m; }, {}))}`);
console.log(`  priced so far  ${money(domainMoney)}`);

/* The point of the whole exercise: the receipt must land ON the plan row, not
   float unattached, and the monthly figure must be the one on the invoice. */
const receipts = await listReceipts();
const zr = receipts.filter((r) => /zapmail/i.test(r.vendor));
console.log(`\n${zr.length} Zapmail receipt(s) in the vault`);
for (const r of zr) {
  const on = r.itemId ? items.find((i) => i.id === r.itemId) : null;
  console.log(`  ${r.period}  ${money(r.amountUsd)}  ${r.invoiceNumber || "(no number)"}  ${r.source}  -> ${on ? `${on.vendor} · ${on.label}` : "UNLINKED"}`);
}

const live = await attachLive(items);
const burn = rollupBurn(live);
console.log(`\nthe whole book, the split the owner asked for`);
console.log(`  recurring, committed   ${money(burn.committedMonthlyUsd)} / month`);
console.log(`  metered                ${money(burn.meteredUsd)}`);
console.log(`  one-time, all time     ${money(burn.oneTimeTotalUsd)}  (${money(burn.oneTime90dUsd)} in the last 90 days)`);
console.log(`  rows still unpriced    ${burn.needsAmountCount}`);
console.log(`  Zapmail's share of the monthly commitment: ${money(burn.byVendor?.Zapmail ?? 0)}`);

const matrix = buildSpendMatrix(items, receipts, { months: 3 });
const row = matrix.rows.find((r) => /zapmail/i.test(r.vendor));
if (row) {
  console.log(`\nMonth by month, Zapmail: ${row.label}`);
  console.log(`  ${row.cells.map((c) => `${c.period}: ${c.status}${c.actualUsd ? ` ${money(c.actualUsd)}` : ""}`).join("  |  ")}`);
}
const zapAnoms = matrix.anomalies.filter((a) => /zapmail/i.test(a.vendor || ""));
console.log(`\nZapmail anomalies: ${zapAnoms.length ? zapAnoms.map((a) => `${a.kind} (${a.severity})`).join(", ") : "none"}`);

/* The receipt was filed while the row still read $0, so nothing could route it. Now that
   the row carries the invoice's own figure, the vault repair that runs on every cron tick
   should tie the two together. Prove that here rather than deploying and hoping. */
const fixed = await repairVault();
console.log(`\nvault repair: linked ${fixed.linked}, deduped ${fixed.deduped}, still unlinked ${fixed.unlinked}`);
for (const r of (await listReceipts()).filter((r) => /zapmail/i.test(r.vendor))) {
  const on = r.itemId ? items.find((i) => i.id === r.itemId) : null;
  console.log(`  ${r.period}  ${money(r.amountUsd)}  ${r.invoiceNumber}  -> ${on ? `${on.vendor} · ${on.label}` : "STILL UNLINKED"}`);
}
