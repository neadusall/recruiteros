/**
 * Company matcher · tests.  node tools/test-companymatch.mjs
 *
 * Mirrors the matcher inside rename-buyers.mjs. It exists because the live owner-search test on
 * 2026-08-21 surfaced a real false positive: hunting "Carta" matched "Director Of Media Relations
 * at Magna Carta Records", because the squashed substring "carta" sits inside "magnacartarecords".
 * A false company match is worse than a miss, since it puts outreach in front of a stranger at an
 * employer we were never looking at.
 */

import assert from "node:assert/strict";
import { companyMatches } from "./peopleapi.mjs";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.error("FAIL " + name); console.error(e.message); process.exitCode = 1; }
}

test("THE LIVE FALSE POSITIVE: Carta must not match Magna Carta Records", () => {
  assert.equal(companyMatches("Carta", "Director Of Media Relations at Magna Carta Records"), false);
});

test("the real hits from the same live run still match", () => {
  assert.equal(companyMatches("Carta", "Senior Director of Sales @ Carta"), true);
  assert.equal(companyMatches("Checkr", "Vice President of Sales at Checkr"), true);
  assert.equal(companyMatches("Webflow", "Director of Engineering at Webflow"), true);
  assert.equal(companyMatches("Checkr", "Partner Marketing @ Checkr"), true);
});

test("a headline that names no employer is not a match", () => {
  assert.equal(companyMatches("Carta", "Enterprise B2B Sales Leader | GTM and P&L"), false);
  assert.equal(companyMatches("Checkr", "HR Tech and AI"), false);
});

test("punctuation differences still match through the squashed fallback", () => {
  assert.equal(companyMatches("J.P. Morgan", "VP at JP Morgan"), true);
  assert.equal(companyMatches("Acme Industries", "Controller, Acme  Industries"), true);
});

test("a short company name cannot ride the squashed fallback into a longer word", () => {
  // The fallback needs 8+ squashed characters precisely so short names like "Carta" (5) can only
  // ever match on a word boundary.
  assert.equal(companyMatches("Oura", "Marketing at Ouraring Collective Supply"), false);
  assert.equal(companyMatches("Oura", "Head of Sales at Oura"), true);
});

test("multi-word companies match across whitespace variation", () => {
  assert.equal(companyMatches("Blue Signal", "Recruiter at Blue   Signal Search"), true);
});

console.log("\n" + passed + " passed");
