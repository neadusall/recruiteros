/* Does the spend grid really open at the register start month, and does everything
   charged before it stay off the page? Also writes a fixture for the browser shot. */
import { writeFileSync } from "node:fs";
import { buildSpendMatrix, withinRegister, REGISTER_START_MONTH } from "../lib/owner/spendMatrix";

const item = (id: string, vendor: string, label: string, amountUsd: number, at: string) => ({
  id, vendor, label, category: "software" as const, billing: "monthly" as const,
  amountUsd, at, status: "active" as const, createdAt: at, updatedAt: at,
});
const rcpt = (id: string, vendor: string, itemId: string, period: string, amountUsd: number, source: any) => ({
  id, period, vendor, itemId, amountUsd, currency: "USD", chargedAt: period + "-04",
  kind: "charge" as const, source, confidence: 0.95, hasShot: source !== "api",
  subject: vendor + " invoice", createdAt: period + "-04", updatedAt: period + "-04",
});

const items = [
  item("i1", "Telnyx", "SMS + voice", 34.58, "2026-04-02"),
  item("i2", "Hetzner", "App server", 28.9, "2026-05-11"),
  item("i3", "RapidAPI", "JSearch (Ultra)", 120, "2026-06-01"),
];
const receipts = [
  rcpt("r0", "Telnyx", "i1", "2026-04", 34.58, "api"),
  rcpt("r1", "Telnyx", "i1", "2026-05", 34.58, "api"),   // the one the console was showing
  rcpt("r2", "Hetzner", "i2", "2026-05", 28.9, "email"),
  rcpt("r3", "Telnyx", "i1", "2026-06", 34.58, "api"),
  rcpt("r4", "Hetzner", "i2", "2026-06", 28.9, "email"),
  rcpt("r5", "RapidAPI", "i3", "2026-06", 120, "email"),
  rcpt("r6", "Telnyx", "i1", "2026-07", 41.2, "api"),
  rcpt("r7", "Hetzner", "i2", "2026-07", 28.9, "email"),
];

const m = buildSpendMatrix(items as any, receipts as any, { months: 12, inboxConfigured: true });

const fails: string[] = [];
if (m.months[0] !== REGISTER_START_MONTH) fails.push(`first column is ${m.months[0]}, wanted ${REGISTER_START_MONTH}`);
if (m.months.some((p) => p < REGISTER_START_MONTH)) fails.push(`columns before the start: ${m.months.filter((p) => p < REGISTER_START_MONTH).join(", ")}`);
const cellPeriods = new Set(m.rows.flatMap((r) => r.cells.map((c) => c.period)));
if ([...cellPeriods].some((p) => p < REGISTER_START_MONTH)) fails.push("a row still carries a pre-start cell");
const shownReceipts = m.rows.flatMap((r) => r.cells.flatMap((c) => c.receipts.map((x) => x.id)));
for (const bad of ["r0", "r1", "r2"]) if (shownReceipts.includes(bad)) fails.push(`${bad} (pre-start) is still on the grid`);
for (const good of ["r3", "r4", "r5", "r6", "r7"]) if (!shownReceipts.includes(good)) fails.push(`${good} went missing`);
if (m.anomalies.some((a) => a.period && a.period < REGISTER_START_MONTH)) fails.push("an anomaly still cites a pre-start month");
if (m.totals.receiptCount !== 5) fails.push(`receiptCount ${m.totals.receiptCount}, wanted 5`);
// The register total must equal exactly what the visible columns add up to.
const colSum = Math.round(m.monthTotals.reduce((s, t) => s + t.countedUsd, 0) * 100) / 100;
if (colSum !== m.totals.allTimeCountedUsd) fails.push(`columns add to ${colSum}, header says ${m.totals.allTimeCountedUsd}`);
if (withinRegister({ period: "2026-05" })) fails.push("withinRegister let May through");
if (!withinRegister({ period: "2026-06" })) fails.push("withinRegister rejected June");

console.log("start month:", REGISTER_START_MONTH);
console.log("columns:", m.months.join(" "));
console.log("month totals:", m.monthTotals.map((t) => `${t.period} $${t.countedUsd}`).join(" | "));
console.log(fails.length ? "FAIL\n - " + fails.join("\n - ") : "PASS");

writeFileSync(process.argv[2] || "matrix-fixture.json", JSON.stringify({
  matrix: m, registerStart: REGISTER_START_MONTH,
  receipts: receipts.filter(withinRegister as any),
  sourcing: [], pullers: { lastReportAt: "2026-07-30T09:00:00.000Z", count: 2, states: [] },
  inbox: { configured: true, mailboxes: [{ user: "billing@lumesp.com", host: "mail.lumesp.com", port: 993 }], lastSweepAt: "2026-07-31T06:00:00.000Z", sweeps: [], envKeys: [] },
  knownVendors: [],
}, null, 1));
if (fails.length) process.exit(1);
