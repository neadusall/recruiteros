/**
 * One charge, one line: regression suite.
 * Run: npx tsx scripts/test-receipt-lines.mts   (exits non-zero on failure)
 *
 * RapidAPI bills five listings separately, on five invoices, with five numbers and five
 * dates. Filed by vendor alone they collapse into one "RapidAPI" block worth $433.99 while
 * all five register rows underneath read "no receipt": the money proven and the rows still
 * looking unpaid. This pins the routing that stops that, against the eight real invoices
 * actually on file (BG95YPTX-0001 through -0009, July 2026), and the duplicate rule.
 *
 * The rules that matter:
 *   - each of the eight invoices lands on the listing it paid for, not on a sibling;
 *   - the vendor's product name and our register label differ ("Realtime LinkedIn Data
 *     Scraper" vs "Realtime LinkedIn Fresh Data") and it still resolves;
 *   - two listings named alike are left UNROUTED rather than guessed at;
 *   - the price decides when the name cannot;
 *   - a row that had not started in that month is not offered the charge;
 *   - same vendor + same money + same day is one charge, however many rows exist for it;
 *   - ...unless the invoice numbers or the line items say they are genuinely two charges;
 *   - the copy holding the vendor's own document is the one kept.
 */

import { resolveSpendItem, findDuplicates, nameTokens, type DupeCandidate } from "../lib/owner/receiptMatch";
import type { SpendItem } from "../lib/owner/spendRegister";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` (got ${g}, want ${w})`}`);
}

/* ============ the register, exactly as it stands in production ============ */

function item(id: string, label: string, amountUsd: number, at: string, host: string): SpendItem {
  return {
    id, vendor: "RapidAPI", label, category: "people", billing: "monthly",
    amountUsd, at, status: "active", link: { rapidHost: host },
    createdAt: at, updatedAt: at,
  } as SpendItem;
}

const RAPID: SpendItem[] = [
  item("spend_jsearch", "JSearch (Ultra)", 75, "2026-06-24", "jsearch.p.rapidapi.com"),
  item("spend_websearch", "Real-Time Web Search", 75, "2026-06-01", "real-time-web-search.p.rapidapi.com"),
  item("spend_rtli", "Realtime LinkedIn Fresh Data", 99.99, "2026-06-01", "realtime-linkedin-fresh-data.p.rapidapi.com"),
  item("spend_freshli", "Fresh LinkedIn Scraper API", 49, "2026-06-01", "fresh-linkedin-scraper-api.p.rapidapi.com"),
  item("spend_skip", "Skip Tracing Working API", 60, "2026-07-01", "skip-tracing-working-api.p.rapidapi.com"),
];

/* The eight invoices sitting in the vault, as the portal puller filed them. */
const FILED = [
  { inv: "BG95YPTX-0001", period: "2026-06", at: "2026-06-16", amt: 99.99, desc: "Realtime LinkedIn Data Scraper", want: "spend_rtli" },
  { inv: "BG95YPTX-0002", period: "2026-06", at: "2026-06-19", amt: 49, desc: "Fresh LinkedIn Scraper API", want: "spend_freshli" },
  { inv: "BG95YPTX-0004", period: "2026-06", at: "2026-06-24", amt: 75, desc: "JSearch", want: "spend_jsearch" },
  { inv: "BG95YPTX-0005", period: "2026-07", at: "2026-07-01", amt: 150, desc: "Real-Time Web Search", want: "spend_websearch" },
  { inv: "BG95YPTX-0006", period: "2026-07", at: "2026-07-16", amt: 99.99, desc: "Realtime LinkedIn Data Scraper", want: "spend_rtli" },
  { inv: "BG95YPTX-0007", period: "2026-07", at: "2026-07-19", amt: 49, desc: "Fresh LinkedIn Scraper API", want: "spend_freshli" },
  { inv: "BG95YPTX-0008", period: "2026-07", at: "2026-07-20", amt: 60, desc: "Skip Tracing Working API", want: "spend_skip" },
  { inv: "BG95YPTX-0009", period: "2026-07", at: "2026-07-24", amt: 75, desc: "JSearch", want: "spend_jsearch" },
];

for (const f of FILED) {
  const hit = resolveSpendItem({ vendor: "RapidAPI", description: f.desc, amountUsd: f.amt, period: f.period }, RAPID);
  check(`${f.inv} $${f.amt} "${f.desc}"`, hit?.item.id, f.want);
}

/* Every listing ends up with its own receipts and none is left holding another's. */
{
  const byItem: Record<string, number> = {};
  for (const f of FILED) {
    const id = resolveSpendItem({ vendor: "RapidAPI", description: f.desc, amountUsd: f.amt, period: f.period }, RAPID)?.item.id || "-";
    byItem[id] = (byItem[id] || 0) + 1;
  }
  check("all eight invoices are routed", byItem["-"] || 0, 0);
  check("five listings, each with its own charges", Object.keys(byItem).sort(), [
    "spend_freshli", "spend_jsearch", "spend_rtli", "spend_skip", "spend_websearch",
  ]);
  check("July's five charges total $433.99",
    FILED.filter((f) => f.period === "2026-07").reduce((s, f) => s + f.amt, 0), 433.99);
}

/* ============ where it must NOT guess ============ */
{
  /* Two listings whose names give nothing away and which cost the same: unroutable, and
     saying so beats crediting one with the other's money. */
  const twins: SpendItem[] = [
    item("a", "Data Plan", 40, "2026-06-01", "alpha.p.rapidapi.com"),
    item("b", "Data Plan Plus", 40, "2026-06-01", "beta.p.rapidapi.com"),
  ];
  check("an ambiguous name is left unrouted",
    resolveSpendItem({ vendor: "RapidAPI", description: "Data", amountUsd: 40, period: "2026-07" }, twins), null);
  check("a charge for something not on the register is left unrouted",
    resolveSpendItem({ vendor: "RapidAPI", description: "Weather Forecast API", amountUsd: 12, period: "2026-07" }, RAPID), null);
  check("an unknown vendor is left unrouted",
    resolveSpendItem({ vendor: "Nobody", description: "JSearch", amountUsd: 75, period: "2026-07" }, RAPID), null);
}
{
  /* Nothing in the name, but only one row is priced at it. */
  const priced: SpendItem[] = [
    item("cheap", "Alpha", 25, "2026-06-01", "alpha.p.rapidapi.com"),
    item("dear", "Beta", 90, "2026-06-01", "beta.p.rapidapi.com"),
  ];
  check("the price decides when the name cannot",
    resolveSpendItem({ vendor: "RapidAPI", description: "Invoice", amountUsd: 90, period: "2026-07" }, priced)?.item.id, "dear");
}
{
  check("a single line takes the charge without argument",
    resolveSpendItem({ vendor: "RapidAPI", description: "anything at all", amountUsd: 5, period: "2026-07" }, [RAPID[0]])?.item.id,
    "spend_jsearch");
  /* Skip Tracing was not subscribed until July, so a June charge cannot be its however
     exactly the name matches, because that would be money credited to a month the line did not
     exist in. The identical charge in July is. */
  check("a row that had not started is not offered the charge",
    resolveSpendItem({ vendor: "RapidAPI", description: "Skip Tracing Working API", amountUsd: 60, period: "2026-06" }, RAPID),
    null);
  check("...and the same charge in the month it did start is",
    resolveSpendItem({ vendor: "RapidAPI", description: "Skip Tracing Working API", amountUsd: 60, period: "2026-07" }, RAPID)?.item.id,
    "spend_skip");
  check("the name still beats the price when they disagree",
    resolveSpendItem({ vendor: "RapidAPI", description: "Real-Time Web Search", amountUsd: 99.99, period: "2026-07" }, RAPID)?.item.id,
    "spend_websearch");
}
{
  check("the host slug is read as the listing name", nameTokens("fresh-linkedin-scraper-api.p.rapidapi.com"),
    ["fresh", "linkedin", "scraper", "rapidapi", "com"].filter((t) => !["rapidapi", "com"].includes(t)));
}

/* ============ the same charge, filed twice ============ */

function rc(o: Partial<DupeCandidate> & { id: string }): DupeCandidate {
  return {
    vendor: "RapidAPI", amountUsd: 75, chargedAt: "2026-07-24", source: "portal",
    createdAt: "2026-07-25T00:00:00.000Z", ...o,
  };
}

{
  const dupes = findDuplicates([
    rc({ id: "keep", invoiceNumber: "BG95YPTX-0009", fileMime: "application/pdf", hasShot: true }),
    rc({ id: "copy", source: "email" }),
  ]);
  check("one charge filed twice is one duplicate", dupes.length, 1);
  check("the copy with the vendor's document is kept", dupes[0]?.keep.id, "keep");
  check("the other copy goes", dupes[0]?.drop.map((d) => d.id), ["copy"]);
}
{
  const two = findDuplicates([
    rc({ id: "a", invoiceNumber: "BG95YPTX-0009" }),
    rc({ id: "b", invoiceNumber: "BG95YPTX-0010" }),
  ]);
  check("two invoice numbers means two charges, not a duplicate", two.length, 0);
}
{
  const two = findDuplicates([
    rc({ id: "a", itemId: "spend_jsearch" }),
    rc({ id: "b", itemId: "spend_websearch" }),
  ]);
  check("two listings at the same price on the same day are two charges", two.length, 0);
}
{
  check("a different day is a different charge",
    findDuplicates([rc({ id: "a" }), rc({ id: "b", chargedAt: "2026-07-25" })]).length, 0);
  check("a different amount is a different charge",
    findDuplicates([rc({ id: "a" }), rc({ id: "b", amountUsd: 49 })]).length, 0);
  check("a different vendor is a different charge",
    findDuplicates([rc({ id: "a" }), rc({ id: "b", vendor: "Serper" })]).length, 0);
}
{
  /* Three copies of one charge collapse to one, not to two pairs. */
  const three = findDuplicates([rc({ id: "a" }), rc({ id: "b" }), rc({ id: "c", fileMime: "application/pdf" })]);
  check("three copies collapse to one keeper", three.length, 1);
  check("...and the two without a document are dropped", three[0]?.drop.map((d) => d.id).sort(), ["a", "b"]);
  check("the keeper is the one holding the invoice", three[0]?.keep.id, "c");
}
{
  /* Real vault shape: the eight filed invoices contain no duplicates at all. */
  const filed = FILED.map((f) => rc({ id: f.inv, invoiceNumber: f.inv, amountUsd: f.amt, chargedAt: f.at, fileMime: "application/pdf" }));
  check("the eight invoices on file are eight separate charges", findDuplicates(filed).length, 0);
}
{
  check("a second pass finds nothing left to remove", (() => {
    const rows = [rc({ id: "a" }), rc({ id: "b", fileMime: "application/pdf" })];
    const first = findDuplicates(rows);
    const gone = new Set(first.flatMap((g) => g.drop.map((d) => d.id)));
    return findDuplicates(rows.filter((r) => !gone.has(r.id))).length;
  })(), 0);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
