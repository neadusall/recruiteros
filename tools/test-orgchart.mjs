/**
 * RecruitersOS · org-chart model tests.
 *
 * The cases below are the owner's own worked examples plus the ones that decide whether the model
 * is actually doing anything: a junior req at a big company must NOT route to the C-suite, and the
 * same req at a small company must. If those two ever agree, the size tiers have stopped mattering
 * and the model has collapsed back into plain function matching.
 *
 *   node tools/test-orgchart.mjs
 */

import assert from "node:assert/strict";
import { levelOf, tierOf, targetFor, fitOf, describe, LEVEL, LEVEL_NAME } from "./orgchart.mjs";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.error("FAIL " + name); console.error(e.message); process.exitCode = 1; }
}

/* ── seniority reading ────────────────────────────────────────────────────────────────────────── */

test("levelOf reads the ladder", () => {
  assert.equal(levelOf("Chief Financial Officer"), LEVEL.clevel);
  assert.equal(levelOf("CFO"), LEVEL.clevel);
  assert.equal(levelOf("VP of Sales"), LEVEL.vp);
  assert.equal(levelOf("Head of Engineering"), LEVEL.vp);
  assert.equal(levelOf("Controller"), LEVEL.director);
  assert.equal(levelOf("Director of Finance"), LEVEL.director);
  assert.equal(levelOf("Accounting Manager"), LEVEL.manager);
  assert.equal(levelOf("Senior Accountant"), LEVEL.senior_ic);
  assert.equal(levelOf("Accounts Payable Clerk"), LEVEL.ic);
});

test("levelOf: 'Staff' is entry in accounting and senior in engineering", () => {
  // Same word, opposite rung. Getting this wrong aims a Staff Accountant req at a VP.
  assert.equal(levelOf("Staff Accountant"), LEVEL.ic);
  assert.equal(levelOf("Staff Software Engineer"), LEVEL.senior_ic);
});

test("levelOf: assistant and deputy seats sit a rung below the real one", () => {
  assert.equal(levelOf("Assistant Controller"), LEVEL.manager);
  assert.equal(levelOf("Deputy General Counsel"), LEVEL.vp);
  // ...and an EA is not the executive.
  assert.ok(levelOf("Executive Assistant to the CFO") < LEVEL.clevel);
});

test("tierOf splits on the org-design thresholds", () => {
  assert.equal(tierOf(120).key, "flat");
  assert.equal(tierOf(250).key, "flat");
  assert.equal(tierOf(251).key, "functional");
  assert.equal(tierOf(1000).key, "functional");
  assert.equal(tierOf(1001).key, "layered");
  assert.equal(tierOf(undefined), null, "unknown size must be explicit, not guessed");
});

/* ── the owner's worked examples ──────────────────────────────────────────────────────────────── */

test("Controller req at 2,000 routes to VP Finance / CFO", () => {
  const t = targetFor({ role: "Controller", functionGroup: "Finance", headcount: 2000 });
  assert.equal(t.min, LEVEL.vp);
  assert.equal(t.max, LEVEL.clevel);
  assert.ok(t.titles.some((x) => /Chief Financial Officer/i.test(x)), t.titles.join(", "));
});

test("VP of Sales req at 2,000 routes to the CRO and nobody else", () => {
  const t = targetFor({ role: "VP of Sales", functionGroup: "Sales", headcount: 2000 });
  assert.equal(t.min, LEVEL.clevel);
  assert.equal(t.max, LEVEL.clevel);
  assert.ok(t.titles.some((x) => /Chief Revenue Officer/i.test(x)), t.titles.join(", "));
});

test("THE CASE THAT MATTERS: a junior req at a big company does NOT route to the C-suite", () => {
  const big = targetFor({ role: "Staff Accountant", functionGroup: "Finance", headcount: 2000 });
  assert.equal(big.min, LEVEL.manager);
  assert.equal(big.max, LEVEL.director, "a clerk req is owned by a Manager or Controller, not the CFO");
  assert.ok(!big.titles.some((x) => /Chief Financial/i.test(x)), big.titles.join(", "));

  // ...and the SAME req at a small company does, because those layers do not exist there.
  const small = targetFor({ role: "Staff Accountant", functionGroup: "Finance", headcount: 150 });
  assert.equal(small.max, LEVEL.clevel);
  assert.ok(small.ownerBuys, "at ≤250 the owner is genuinely in the loop");
});

test("an executive search is the CEO's call at any size", () => {
  for (const n of [120, 800, 2400]) {
    const t = targetFor({ role: "Chief Financial Officer", functionGroup: "Executive", headcount: n });
    assert.equal(t.isExecReq, true);
    assert.equal(t.ownerBuys, true, `size ${n}`);
  }
});

/* ── fit scoring: who we accept, who we refuse ────────────────────────────────────────────────── */

const fit = (role, fnGroup, headcount, buyerTitle, buyerFunction) =>
  fitOf({ role, functionGroup: fnGroup, headcount, buyerTitle, buyerFunction });

test("the CFO is the right buyer for a Controller req, and the wrong one for a clerk req", () => {
  assert.equal(fit("Controller", "Finance", 2000, "Chief Financial Officer", "Finance").ok, true);
  const clerk = fit("Staff Accountant", "Finance", 2000, "Chief Financial Officer", "Finance");
  assert.equal(clerk.ok, false);
  assert.ok(/above the/.test(clerk.why), clerk.why);
});

test("a buyer below the band is refused too", () => {
  const r = fit("Controller", "Finance", 2000, "Senior Accountant", "Finance");
  assert.equal(r.ok, false);
  assert.ok(/below the/.test(r.why), r.why);
});

test("the CEO is refused above 250 and accepted below it", () => {
  assert.equal(fit("Accounting Manager", "Finance", 2000, "Chief Executive Officer", "universal").ok, false);
  assert.equal(fit("Accounting Manager", "Finance", 700, "Chief Executive Officer", "universal").ok, false,
    "at 251-1,000 the function head is the buyer, not the CEO");
  assert.equal(fit("Accounting Manager", "Finance", 180, "Chief Executive Officer", "universal").ok, true);
});

test("a different-function leader is never the buyer", () => {
  const r = fit("Controller", "Finance", 2000, "Chief Technology Officer", "Engineering");
  assert.equal(r.ok, false);
  assert.ok(/not the Finance function/.test(r.why), r.why);
});

test("rank prefers the closest rung, so ordering beats accept/reject", () => {
  // Controller req at 2,000: VP Finance is ideal, the CFO is acceptable but one rung further away.
  const vp = fit("Controller", "Finance", 2000, "VP of Finance", "Finance");
  const cfo = fit("Controller", "Finance", 2000, "Chief Financial Officer", "Finance");
  assert.equal(vp.ok && cfo.ok, true);
  assert.ok(vp.rank < cfo.rank, `VP rank ${vp.rank} should beat CFO rank ${cfo.rank}`);
});

test("every function in the chain resolves a real title at every tier", () => {
  const rows = describe();
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(r.buyerTitles.length > 0, `${r.functionGroup} / ${r.tierLabel} / ${r.reqLevelName} has no target title`);
    assert.ok(r.why && r.why.length > 20, "every row must explain itself to the recruiter reading it");
  }
});

test("unknown headcount still targets somebody rather than stalling the desk", () => {
  const t = targetFor({ role: "Controller", functionGroup: "Finance", headcount: null });
  assert.ok(t.titles.length > 0);
  assert.equal(t.tier, "flat", "unknown size reads as the widest band, never as no band");
});

console.log("\n" + passed + " passed");
