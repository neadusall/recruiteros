/**
 * Predictive hiring intent · tests.
 *
 *   npx tsx integration/lib/linkedin/hiringIntent.test.ts
 *
 * The two cases that matter most are the owner's own worked pair: a Series B post that reasons
 * through to real hiring demand must score high, and "congratulations on another strong quarter"
 * must not. If those two ever converge, the score has stopped discriminating and the hunter is
 * back to commenting on anything with growth words in it.
 */

import assert from "node:assert/strict";
import { readIntent, commentBrief, THRESHOLDS, HIRING_EVENTS, SCORE_WEIGHTS } from "./hiringIntent";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.error("FAIL " + name); console.error((e as Error).message); process.exitCode = 1; }
}

const DESK = ["Finance", "Operations", "Sales", "Engineering"];
const read = (text: string, over: Partial<Parameters<typeof readIntent>[0]> = {}) =>
  readIntent({ text, authorTitle: "Chief Executive Officer", headcount: 600, deskFunctions: DESK, postAt: new Date(), ...over });

/* ── the owner's worked pair ──────────────────────────────────────────────────────────────────── */

test("THE PAIR: a Series B with a plan scores high, a congratulations post does not", () => {
  const hot = read("Huge milestone for Acme. We just closed our Series B and couldn't be more excited about what's ahead. The capital will allow us to accelerate expansion across the Southeast and continue investing in our platform.");
  const cold = read("Congratulations to everyone involved in another successful quarter. Proud of this team.");

  assert.ok(hot.score >= THRESHOLDS.engage, `Series B scored ${hot.score}, expected >= ${THRESHOLDS.engage}`);
  assert.ok(cold.score < THRESHOLDS.engage, `congrats post scored ${cold.score}, expected < ${THRESHOLDS.engage}`);
  assert.ok(hot.score - cold.score >= 25, `the two must separate clearly, got ${hot.score} vs ${cold.score}`);
});

test("the Series B read reasons through to the functions that will hire", () => {
  const r = read("We just closed our Series B. The capital lets us accelerate expansion across the Southeast and keep investing in the platform.");
  assert.equal(r.layer, 2, "a funding post is event-based, not explicit");
  assert.ok(r.impliedFunctions.includes("Finance"), r.impliedFunctions.join(", "));
  assert.ok(r.impliedFunctions.length >= 2, "one event should imply demand across more than one function");
  assert.equal(r.action, r.score >= THRESHOLDS.act ? "act" : "engage");
});

/* ── the three layers ─────────────────────────────────────────────────────────────────────────── */

test("layer 1: explicit hiring is detected and outranks a co-occurring event", () => {
  const r = read("We closed our Series A and we're hiring a Controller to help us scale.");
  assert.equal(r.layer, 1, "explicit hiring must win the layer when both are present");
  assert.ok(r.score >= THRESHOLDS.act, `explicit + event should be top band, got ${r.score}`);
});

test("layer 2: the event catalog covers the owner's ten categories", () => {
  // Fixtures are written at realistic post length on purpose: readIntent ignores anything under
  // 40 characters, because a fragment that short is a comment or a repost stub rather than an
  // announcement. Terse one-liners here passed the regex and still scored zero, which looked like
  // a catalog gap and was actually the length guard doing its job.
  const cases: Array<[string, string]> = [
    ["Excited to announce our $18M Series A led by Foo Capital, with our existing investors joining.", "funding"],
    ["Partnering with Riverside Capital for our next chapter of growth across the region.", "pe_investment"],
    ["We have acquired Northwind Logistics and are excited about what the combined team can do.", "acquisition"],
    ["Opening our first Dallas office this spring and looking forward to serving customers there.", "new_location"],
    ["We are expanding into three new states this year as demand keeps building across the region.", "expansion"],
    ["Thrilled to welcome Walmart as a customer after a long and thorough evaluation process.", "major_customer"],
    ["Awarded a five-year contract with the state, which the whole team worked hard to win.", "contract_win"],
    ["Excited to welcome our new COO to the team as we head into our next phase together.", "exec_hire"],
    ["Beginning our NetSuite implementation next month after a long selection process.", "erp_transformation"],
    ["Breaking ground on our new facility in Ohio, which doubles our footprint in the Midwest.", "new_facility"],
    ["Entering the European market this year, starting with a small team on the ground.", "international"],
  ];
  for (const [text, id] of cases) {
    const r = read(text);
    assert.ok(r.events.some((e) => e.id === id), `"${text}" should fire ${id}, got [${r.events.map((e) => e.id).join(", ")}]`);
  }
});

test("layer 3: the quiet signals fire, which is the whole point of layer 3", () => {
  for (const [text, id] of [
    ["Demand is exceeding our expectations and honestly we cannot keep up with the volume.", "demand_strain"],
    ["Honestly I am still wearing too many hats around here and it is starting to show.", "founder_bottleneck"],
    ["Time to professionalise the finance function for our next stage of growth.", "professionalise"],
    ["We doubled revenue again this year, which still does not feel real to write down.", "hypergrowth"],
  ] as Array<[string, string]>) {
    const r = read(text);
    assert.ok(r.events.some((e) => e.id === id), `"${text}" should fire ${id}`);
  }
});

/* ── scoring behaviour ────────────────────────────────────────────────────────────────────────── */

test("compounding inputs raise the score, and each weight actually moves it", () => {
  const base = "We just closed our Series B and are getting to work on the plan behind it.";
  const junior = read(base, { authorTitle: "Marketing Coordinator" });
  const exec = read(base, { authorTitle: "Chief Executive Officer" });
  assert.ok(exec.score > junior.score, "authority must count");

  const stale = read(base, { postAt: new Date(Date.now() - 30 * 864e5) });
  assert.ok(exec.score > stale.score, "recency must count");

  const offBand = read(base, { headcount: 40000 });
  assert.ok(exec.score > offBand.score, "company fit must count");

  const offDesk = read(base, { deskFunctions: ["Legal"] });
  assert.ok(exec.score > offDesk.score, "role relevance must count");
});

test("an unknown headcount scores zero fit, never a guess", () => {
  const known = read("We just closed our Series B and are getting to work on the plan behind it.", { headcount: 600 });
  const unknown = read("We just closed our Series B and are getting to work on the plan behind it.", { headcount: null });
  assert.equal(known.score - unknown.score, SCORE_WEIGHTS.companyFit,
    "an unresolved company must not outrank a resolved one on our own missing data");
});

test("a post with no event at all is free and returns nothing", () => {
  const r = read("Great to see everyone at the conference this week. Lots of good conversations and a very full agenda throughout.");
  assert.equal(r.layer, null);
  assert.equal(r.score, 0);
  assert.equal(r.action, "ignore");
  assert.equal(r.primary, null);
});

test("thresholds are ordered and the action matches the band", () => {
  assert.ok(THRESHOLDS.act > THRESHOLDS.engage && THRESHOLDS.engage > THRESHOLDS.track);
  const r = read("We just closed our Series B and are expanding across the Southeast.");
  const expected = r.score >= THRESHOLDS.act ? "act" : r.score >= THRESHOLDS.engage ? "engage" : r.score >= THRESHOLDS.track ? "track" : "ignore";
  assert.equal(r.action, expected);
});

/* ── the comment brief ────────────────────────────────────────────────────────────────────────── */

test("an event brief forbids the congratulations-and-pitch move", () => {
  const r = read("Excited to announce our $18M Series A led by Foo Capital.");
  const brief = commentBrief(r, "Controller", "Dallas");
  assert.ok(/NOT advertising a job/i.test(brief), brief);
  assert.ok(/[Dd]o not congratulate/.test(brief), "the brief must ban the congratulations opener");
  assert.ok(/do not (?:ask if they are hiring|offer candidates)/i.test(brief), "it must ban asking for the job order");
  assert.ok(brief.includes(r.primary!.whatFollows), "the brief must carry what actually happens next");
});

test("an explicit-hiring brief still names the role", () => {
  const r = read("We're hiring a Controller in Dallas, send candidates my way.");
  const brief = commentBrief(r, "Controller", "Dallas");
  assert.ok(/Controller/.test(brief) && /Dallas/.test(brief), brief);
});

/* ── catalog hygiene ──────────────────────────────────────────────────────────────────────────── */

test("every event is well-formed and none of them fire on a plain congratulations", () => {
  const ids = new Set<string>();
  for (const e of HIRING_EVENTS) {
    assert.ok(!ids.has(e.id), `duplicate event id ${e.id}`);
    ids.add(e.id);
    assert.ok(e.functions.length > 0, `${e.id} implies no functions`);
    assert.ok(e.whatFollows.length > 20, `${e.id} has no usable "what follows" line`);
    assert.ok([3, 4, 5].includes(e.heat), `${e.id} has an odd heat`);
    assert.equal(e.match.test("Congratulations to the team on a great quarter."), false,
      `${e.id} fires on a plain congratulations post`);
  }
});

test("the weights still sum to 100, so the score stays a percentage", () => {
  const total = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100, `weights sum to ${total}`);
});

console.log("\n" + passed + " passed");
