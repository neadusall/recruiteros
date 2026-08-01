/**
 * A waived month is the owner saying "nothing was billed here". Regression suite.
 * Run: npx tsx scripts/test-spend-waive.mts   (exits non-zero on failure)
 *
 * The Spend master grid projects a monthly line's price into every active month as an
 * estimate. `noChargePeriods` lets the owner blank ONE cell — a skipped month, a comped
 * one, a line that only bills some months — without touching the row or any other month.
 * What is pinned here:
 *   - a waived month reports status "waived", expects $0 and counts $0;
 *   - it is NOT a missing-receipt gap and adds nothing to the month total, so the coverage
 *     figure is never dragged down by a month the owner has already accounted for;
 *   - every other month, and a plain row with nothing waived, read exactly as before;
 *   - a real receipt landing in a waived month still shows and reconciles: the waiver
 *     silences the ESTIMATE, never a charge that actually happened;
 *   - hidePeriod / showPeriod toggle one month at a time and reject anything not YYYY-MM,
 *     and emptying the set drops back to no field at all rather than an empty array.
 */

import { buildSpendMatrix, waivedIn } from "../lib/owner/spendMatrix";
import { addSpendItem, updateSpendItem } from "../lib/owner/spendRegister";
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

const T = "2026-06-01T00:00:00.000Z";
let seq = 0;
function item(over: Partial<SpendItem> = {}): SpendItem {
  return {
    id: `sp_${++seq}`, vendor: "ElevenLabs", label: "Voice cloning",
    category: "ai", billing: "monthly", amountUsd: 22, at: "2026-06-01",
    status: "active", verified: false, seeded: true, createdAt: T, updatedAt: T,
    ...over,
  } as SpendItem;
}
/** A receipt filed to the row it paid for, exactly as the vault stores it. */
function receipt(period: string, amountUsd: number, over: Partial<Receipt> = {}): Receipt {
  return {
    id: `rc_${++seq}`, vendor: "ElevenLabs", period, amountUsd,
    chargedAt: `${period}-15T00:00:00.000Z`, currency: "USD", kind: "charge",
    source: "manual", confidence: 1, hasShot: false, createdAt: T, updatedAt: T,
    ...over,
  } as Receipt;
}

const waived = { noChargePeriods: ["2026-07"] };
function cellAt(items: SpendItem[], receipts: Receipt[], period: string) {
  const m = buildSpendMatrix(items, receipts, { months: 24 });
  const row = m.rows.find((r) => r.vendor === "ElevenLabs");
  return { m, row, cell: row?.cells.find((c) => c.period === period) };
}

/* ---- 1. the window under test is actually in the report ---------------------------- */
{
  const { m } = cellAt([item(waived)], [], "2026-07");
  check("July is inside the reported window", m.months.includes("2026-07"), true);
}

/* ---- 2. a waived month expects nothing and says so --------------------------------- */
{
  const { cell } = cellAt([item(waived)], [], "2026-07");
  check("waived month status", cell?.status, "waived");
  check("waived month expects nothing", cell?.expectedUsd, 0);
  check("waived month counts nothing", cell?.countedUsd, 0);
  check("waived month says it was cleared on purpose", cell?.note, "marked as no charge");
}

/* ---- 3. a waived month is not a gap and drags nothing down -------------------------- */
{
  const { m } = cellAt([item(waived)], [], "2026-07");
  const missing = m.anomalies.filter((a) => a.period === "2026-07" && String(a.kind).includes("receipt"));
  check("no missing-receipt anomaly for the waived month", missing.length, 0);
  const july = m.monthTotals.find((p) => p.period === "2026-07");
  check("waived month adds nothing to the month total", july?.countedUsd, 0);
  check("and nothing to the expected total either", july?.expectedUsd, 0);
  /* July stops being a gap: the row's missing count is exactly one lower than the same row
     with nothing waived (June, its start month, stays missing in both). */
  const waivedMissing = cellAt([item(waived)], [], "2026-07").row?.missingCount ?? -1;
  const plainMissing = cellAt([item()], [], "2026-07").row?.missingCount ?? -1;
  check("waiving a month removes exactly it from the missing count", plainMissing - waivedMissing, 1);
}

/* ---- 4. every other month is untouched --------------------------------------------- */
{
  const { cell } = cellAt([item(waived)], [], "2026-06");
  check("June still expects the fee", cell?.expectedUsd, 22);
  check("June with no receipt is still a gap", cell?.status, "missing");
}
{
  const plain = item();
  const { cell } = cellAt([plain], [], "2026-07");
  check("a row with nothing waived reads exactly as before", cell?.status, "missing");
  check("expecting the full fee", cell?.expectedUsd, 22);
}

/* ---- 5. a real charge in a waived month still shows and reconciles ------------------ */
{
  const row = item(waived);
  const { cell } = cellAt([row], [receipt("2026-07", 22, { itemId: row.id })], "2026-07");
  check("a charge inside a waived month keeps its money", cell?.actualUsd, 22);
  check("and reconciles rather than staying blank", cell?.status, "paid");
  check("it counts toward the month", cell?.countedUsd, 22);
}

/* ---- 6. waivedIn is exact: one month, not a range ---------------------------------- */
{
  check("waived in the month it names", waivedIn(item(waived), "2026-07"), true);
  check("not waived the month before", waivedIn(item(waived), "2026-06"), false);
  check("not waived the month after", waivedIn(item(waived), "2026-08"), false);
  check("a row with nothing waived is never waived", waivedIn(item(), "2026-07"), false);
  const many = item({ noChargePeriods: ["2026-06", "2026-08"] });
  check("each named month is waived", waivedIn(many, "2026-06") && waivedIn(many, "2026-08"), true);
  check("and the gap between them is NOT", waivedIn(many, "2026-07"), false);
}

/* ---- 7. hidePeriod / showPeriod toggle one month at a time -------------------------- */
{
  const created = await addSpendItem({ vendor: "WaiveTest", label: "Toggle", billing: "monthly", amountUsd: 22, at: "2026-06-01" });

  const a = await updateSpendItem(created.id, { hidePeriod: "2026-06" } as Partial<SpendItem>);
  check("hiding a month records it", a?.noChargePeriods, ["2026-06"]);

  const b = await updateSpendItem(created.id, { hidePeriod: "2026-07" } as Partial<SpendItem>);
  check("hiding a second month keeps both, sorted", b?.noChargePeriods, ["2026-06", "2026-07"]);

  const c = await updateSpendItem(created.id, { hidePeriod: "2026-06" } as Partial<SpendItem>);
  check("hiding one already hidden does not duplicate it", c?.noChargePeriods, ["2026-06", "2026-07"]);

  const d = await updateSpendItem(created.id, { hidePeriod: "nope" } as Partial<SpendItem>);
  check("a value that is not YYYY-MM is ignored", d?.noChargePeriods, ["2026-06", "2026-07"]);

  const e = await updateSpendItem(created.id, { showPeriod: "2026-06" } as Partial<SpendItem>);
  check("restoring a month removes just that one", e?.noChargePeriods, ["2026-07"]);

  const f = await updateSpendItem(created.id, { showPeriod: "2026-07" } as Partial<SpendItem>);
  check("emptying the set drops the field entirely", f?.noChargePeriods, undefined);

  const g = await updateSpendItem(created.id, { noChargePeriods: ["2026-09", "bad", "2026-09"] });
  check("a full-array write de-dupes and drops non-months", g?.noChargePeriods, ["2026-09"]);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
