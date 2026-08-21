/**
 * Account intent ledger · tests.
 *
 *   npx tsx integration/lib/linkedin/intentLedger.test.ts
 *
 * The behaviour that matters is the owner's compounding example: funding Monday, expansion
 * Wednesday, infrastructure Friday, all from the same company, should put that account at the top
 * of the list. And the failure mode that would quietly ruin it is a chatty founder posting about
 * one raise five times and outranking a company with three real events.
 */

import assert from "node:assert/strict";
import { readIntent } from "./hiringIntent";
import { recordSignal, rankAccounts, heatOf, liveSignals, pruneLedger, ACCOUNT_HOT, type IntentLedger } from "./intentLedger";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.error("FAIL " + name); console.error((e as Error).message); process.exitCode = 1; }
}

const DESK = ["Finance", "Operations", "Sales", "Engineering"];
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString();
const post = (text: string, at: string, url: string) => ({
  company: "Acme Industries", domain: "acme.com",
  read: readIntent({ text, authorTitle: "Chief Executive Officer", headcount: 600, deskFunctions: DESK, postAt: at }),
  postUrl: url, postAt: at, authorName: "Dana Reed", authorTitle: "Chief Executive Officer",
});

test("THE SEQUENCE: three independent signals compound into a hot account", () => {
  const led: IntentLedger = {};
  recordSignal(led, post("We just closed our Series B and are getting to work on the plan behind it.", daysAgo(14), "p1"));
  const afterOne = heatOf(led.acmeindustries);

  recordSignal(led, post("We are expanding into three new states this year as demand keeps building.", daysAgo(7), "p2"));
  const afterTwo = heatOf(led.acmeindustries);

  recordSignal(led, post("Time to professionalise the finance function for our next stage of growth.", daysAgo(1), "p3"));
  const afterThree = heatOf(led.acmeindustries);

  assert.ok(afterTwo > afterOne, `second signal must raise heat (${afterOne} -> ${afterTwo})`);
  assert.ok(afterThree > afterTwo, `third signal must raise heat (${afterTwo} -> ${afterThree})`);
  assert.ok(afterThree >= ACCOUNT_HOT, `three real signals should make the account hot, got ${afterThree}`);

  const ranked = rankAccounts(led);
  assert.equal(ranked[0].company, "Acme Industries");
  assert.equal(ranked[0].signalCount, 3, "three DISTINCT events");
  assert.ok(ranked[0].hot);
  assert.ok(ranked[0].timeline.length === 3, "the timeline is the reason it is hot, so it must be shown");
});

test("THE FAILURE MODE: the same event posted five times is still one signal", () => {
  const led: IntentLedger = {};
  for (let i = 0; i < 5; i++) {
    recordSignal(led, post("We just closed our Series B and are getting to work on the plan behind it.", daysAgo(10 - i), `dup${i}`));
  }
  const acct = led.acmeindustries;
  assert.equal(liveSignals(acct).length, 1, "one distinct event, however many times it was posted");

  const other: IntentLedger = {};
  recordSignal(other, { ...post("We just closed our Series B and are getting to work on the plan behind it.", daysAgo(10), "a"), company: "Beta Corp" });
  recordSignal(other, { ...post("We are expanding into three new states this year as demand keeps building.", daysAgo(6), "b"), company: "Beta Corp" });
  assert.ok(heatOf(other.betacorp) > heatOf(acct),
    "two real events must outrank one event shouted five times");
});

test("re-reading the same post never inflates heat", () => {
  const led: IntentLedger = {};
  const p = post("Breaking ground on our new facility in Ohio, which doubles our Midwest footprint.", daysAgo(3), "same-url");
  recordSignal(led, p);
  const once = heatOf(led.acmeindustries);
  recordSignal(led, p);
  recordSignal(led, p);
  assert.equal(heatOf(led.acmeindustries), once, "a re-scan must be idempotent");
});

test("heat decays with age, so an old raise is not a live buying signal", () => {
  const fresh: IntentLedger = {};
  recordSignal(fresh, post("We just closed our Series B and are getting to work on the plan behind it.", daysAgo(1), "f"));
  const old: IntentLedger = {};
  recordSignal(old, post("We just closed our Series B and are getting to work on the plan behind it.", daysAgo(80), "o"));
  assert.ok(heatOf(fresh.acmeindustries) > heatOf(old.acmeindustries),
    "a raise from 80 days ago must not read like one from yesterday");
});

test("signals outside the window drop out entirely", () => {
  const led: IntentLedger = {};
  recordSignal(led, post("We just closed our Series B and are getting to work on the plan behind it.", daysAgo(200), "ancient"));
  assert.equal(liveSignals(led.acmeindustries).length, 0);
  assert.equal(heatOf(led.acmeindustries), 0);
  pruneLedger(led);
  assert.equal(Object.keys(led).length, 0, "pruning must keep the snapshot bounded");
  assert.equal(rankAccounts(led).length, 0, "and a dead account never appears on the watchlist");
});

test("the account carries the functions the events point at", () => {
  const led: IntentLedger = {};
  recordSignal(led, post("Beginning our NetSuite implementation next month after a long selection process.", daysAgo(2), "erp"));
  const ranked = rankAccounts(led);
  assert.ok(ranked[0].functions.includes("Finance"), ranked[0].functions.join(", "));
});

test("a post with no event records nothing", () => {
  const led: IntentLedger = {};
  const r = recordSignal(led, post("Congratulations to everyone involved in another successful quarter here.", daysAgo(1), "none"));
  assert.equal(r, null);
  assert.equal(Object.keys(led).length, 0);
});

test("ranking prefers more independent signals when heat ties", () => {
  const led: IntentLedger = {};
  // One 30-strength event today.
  recordSignal(led, { ...post("We just closed our Series B and are getting to work on the plan behind it.", daysAgo(0), "x"), company: "Loud Co" });
  // Two smaller events today, same total-ish heat.
  recordSignal(led, { ...post("Promoted to VP of Operations after four years with this team.", daysAgo(0), "y1"), company: "Quiet Co" });
  recordSignal(led, { ...post("Launching our newest platform to customers this month after a long build.", daysAgo(0), "y2"), company: "Quiet Co" });
  const ranked = rankAccounts(led);
  const loud = ranked.find((a) => a.company === "Loud Co")!;
  const quiet = ranked.find((a) => a.company === "Quiet Co")!;
  if (loud.heat === quiet.heat) {
    assert.ok(ranked.indexOf(quiet) < ranked.indexOf(loud), "at equal heat, more independent signals wins");
  }
  assert.ok(quiet.signalCount === 2 && loud.signalCount === 1);
});

console.log("\n" + passed + " passed");
