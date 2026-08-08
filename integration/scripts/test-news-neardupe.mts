/* Near-duplicate company collapse in news discovery.
 *
 * The bar this pins: a MISSED merge costs one wasted email, a FALSE merge silently
 * deletes a real company from the funnel. So the tests below weight false merges much
 * more heavily than missed ones — every "must NOT merge" case here is a company that
 * would otherwise disappear.
 *
 * Run: npx tsx scripts/test-news-neardupe.mts
 */
import assert from "node:assert";

const { __test } = await import("../lib/signals/watch/newsDiscover");
const { withinOneEdit, collapseNearDuplicates } = __test;

let passed = 0, failed = 0;
function ok(cond: unknown, label: string) {
  if (cond) { passed++; console.log("PASS " + label); }
  else { failed++; console.log("FAIL " + label); }
}
function eq(a: unknown, b: unknown, label: string) {
  try { assert.deepStrictEqual(a, b); passed++; console.log("PASS " + label); }
  catch { failed++; console.log(`FAIL ${label}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
}

/* ---------------- withinOneEdit ---------------- */

ok(withinOneEdit("connerindustries", "connorindustries"), "one substitution is one edit");
ok(withinOneEdit("acmelogistics", "acmelogistic"), "one deletion is one edit");
ok(withinOneEdit("acmelogistic", "acmelogistics"), "one insertion is one edit");
ok(withinOneEdit("same", "same"), "identical strings are within one edit");
ok(!withinOneEdit("connerindustries", "connarindustrees"), "two substitutions are not");
ok(!withinOneEdit("acme", "acmecorporation"), "a long tail is not one edit");
ok(!withinOneEdit("northwind", "southwind"), "different prefixes are not one edit");
// The insertion branch must not silently pass a second edit later in the string.
ok(!withinOneEdit("abcdef", "abXdefX"), "insertion plus substitution is two edits");

/* ---------------- collapseNearDuplicates ---------------- */

type Row = { lead: any; facts: any; signal: any };
const row = (name: string, score: number, signal = "exec_hire", facts: any = {}): Row => ({
  lead: { company: name, score },
  facts,
  signal,
});
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
function build(rows: Array<[string, Row]>): Map<string, Row> {
  return new Map(rows.map(([k, v]) => [key(k), v]));
}

// The live case that prompted this: one board appointment, two outlet spellings.
{
  const m = build([
    ["Conner Industries", row("Conner Industries", 70)],
    ["Connor Industries", row("Connor Industries", 62)],
  ]);
  const n = collapseNearDuplicates(m);
  eq(n, 1, "the live Conner/Connor pair merges");
  eq(m.size, 1, "one company survives");
  eq([...m.values()][0].lead.company, "Conner Industries", "the higher-scoring spelling wins");
}

// A merge must never lose what the other outlet knew.
{
  const m = build([
    ["Conner Industries", row("Conner Industries", 70, "funding_round", { amountUsd: 5e7 })],
    ["Connor Industries", row("Connor Industries", 62, "funding_round", { investor: "Battery" })],
  ]);
  collapseNearDuplicates(m);
  const survivor = [...m.values()][0];
  eq(survivor.facts.amountUsd, 5e7, "the winner keeps its own facts");
  eq(survivor.facts.investor, "Battery", "and absorbs the loser's");
}

// Short names are where one character is the brand, not a typo.
{
  const m = build([["Auger", row("Auger", 83, "funding_round")], ["Augur", row("Augur", 80, "funding_round")]]);
  eq(collapseNearDuplicates(m), 0, "short names are NOT merged");
  eq(m.size, 2, "both short-named companies survive");
}

// Same name distance, different story: two different companies.
{
  const m = build([
    ["Conner Industries", row("Conner Industries", 70, "funding_round")],
    ["Connor Industries", row("Connor Industries", 70, "layoff")],
  ]);
  eq(collapseNearDuplicates(m), 0, "a different signal blocks the merge");
  eq(m.size, 2, "both survive when the stories differ");
}

// Genuinely distinct companies must be left alone.
{
  const m = build([
    ["Northwind Logistics", row("Northwind Logistics", 70)],
    ["Southwind Logistics", row("Southwind Logistics", 70)],
  ]);
  eq(collapseNearDuplicates(m), 0, "two edits apart is not a duplicate");
  eq(m.size, 2, "both real companies survive");
}

// A clean set must come through untouched.
{
  const m = build([
    ["Freehand", row("Freehand", 91, "funding_round")],
    ["Tungsten Automation", row("Tungsten Automation", 66)],
    ["Wayvia", row("Wayvia", 62)],
  ]);
  eq(collapseNearDuplicates(m), 0, "a clean set merges nothing");
  eq(m.size, 3, "and loses nothing");
}

// Three spellings of one company collapse to one, not two.
{
  const m = build([
    ["Conner Industries", row("Conner Industries", 70)],
    ["Connor Industries", row("Connor Industries", 65)],
    ["Conner Industrie", row("Conner Industrie", 60)],
  ]);
  collapseNearDuplicates(m);
  eq(m.size, 1, "a three-way spelling cluster collapses to one");
  eq([...m.values()][0].lead.company, "Conner Industries", "and keeps the best-scoring one");
}

// Order must not decide the winner.
{
  const a = build([["Conner Industries", row("Conner Industries", 60)], ["Connor Industries", row("Connor Industries", 90)]]);
  const b = build([["Connor Industries", row("Connor Industries", 90)], ["Conner Industries", row("Conner Industries", 60)]]);
  collapseNearDuplicates(a); collapseNearDuplicates(b);
  eq([...a.values()][0].lead.company, [...b.values()][0].lead.company, "the winner is independent of insertion order");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
