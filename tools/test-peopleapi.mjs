/**
 * people-search client · tests.  node tools/test-peopleapi.mjs
 *
 * These lock the one distinction the whole owner search depends on: a throttled call and a company
 * with no such leader must NEVER classify the same way. Getting that wrong is what wrote 1,286
 * false "no owner exists" verdicts into the rename ledger, and those verdicts now unlock the
 * C-suite fallback in gates.mjs, so a regression here does not just lose data, it re-aims live
 * outreach at the wrong person.
 */

import assert from "node:assert/strict";
import { classify, extractPeople } from "./peopleapi.mjs";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.error("FAIL " + name); console.error(e.message); process.exitCode = 1; }
}

// The exact body this API returned on 2026-08-21 while 12,382 of 20,000 requests remained.
const THROTTLED = '{"success":false,"message":"Request failed with status 429: Too Many Requests","process_time":278,"cost":1,"page":1,"status_code":200}';
const VALIDATION = '{"success":false,"message":"fail","process_time":0,"cost":1,"page":1,"error":{"issues":[{"code":"invalid_type"}]}}';
const PEOPLE = '{"success":true,"data":[{"full_name":"Dana Reed","title":"Controller at Acme","url":"https://linkedin.com/in/danareed?x=1"}]}';
const GENUINELY_EMPTY = '{"success":true,"data":[]}';

test("THE DISTINCTION: a throttled 202 is never read as an empty result", () => {
  const r = classify(202, THROTTLED);
  assert.equal(r.kind, "ratelimit", "a 429 wearing an HTTP 202 must classify as ratelimit");
  assert.notEqual(r.kind, "empty", "this is the bug: 'empty' would be written to the ledger as no_name");
});

test("a genuine no-result is still a genuine no-result", () => {
  assert.equal(classify(200, GENUINELY_EMPTY).kind, "empty");
});

test("an API validation failure is not a no-result either", () => {
  const r = classify(202, VALIDATION);
  assert.equal(r.kind, "apifail");
});

test("people come back parsed, with tracking stripped from the URL", () => {
  const r = classify(200, PEOPLE);
  assert.equal(r.kind, "people");
  assert.equal(r.people.length, 1);
  assert.equal(r.people[0].fullName, "Dana Reed");
  assert.equal(r.people[0].url, "https://linkedin.com/in/danareed");
});

test("a non-2xx is transport failure, not absence", () => {
  assert.equal(classify(500, "").kind, "http");
  assert.equal(classify(403, "nope").kind, "http");
});

test("unparseable bodies never masquerade as people", () => {
  for (const body of ["", "<html>gateway</html>", "null", "{}"]) {
    const r = classify(202, body);
    assert.notEqual(r.kind, "people", `body ${JSON.stringify(body)} must not read as people`);
  }
});

test("anonymous LinkedIn members are dropped, they are not contactable", () => {
  const people = extractPeople({ data: [{ full_name: "LinkedIn Member", title: "CFO" }, { full_name: "Real Person", title: "CFO" }] });
  assert.equal(people.length, 1);
  assert.equal(people[0].fullName, "Real Person");
});

test("only 'empty' is evidence about the world", () => {
  // The rule the callers rely on: anything other than people/empty means retry and record nothing.
  const recordable = (kind) => kind === "people" || kind === "empty";
  assert.equal(recordable(classify(200, GENUINELY_EMPTY).kind), true);
  assert.equal(recordable(classify(200, PEOPLE).kind), true);
  for (const body of [THROTTLED, VALIDATION]) {
    assert.equal(recordable(classify(202, body).kind), false,
      "a failure must never be recorded as a verdict about the company");
  }
});

console.log("\n" + passed + " passed");
