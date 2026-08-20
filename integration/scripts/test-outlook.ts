/**
 * RecruitersOS · fleet-plan decision table (build gate).
 *
 * The fleet monitor's ONE promise is that a milestone checks off on evidence and
 * never on a date. That promise is only worth anything if it is pinned, so this
 * suite runs inside the Docker build (before the dependency gate) and fails the
 * deploy if any of it stops holding.
 *
 *   npx tsx scripts/test-outlook.ts
 *
 * Every case below is a real failure mode, most of them observed:
 *  - a rung reading "done" because the calendar reached it while the host keeper
 *    was pinned at 8/day (the reason this layer exists)
 *  - a monitor going quiet being read as the machinery moving backwards
 *  - a partially applied rung reading as a completed one
 *  - the finished tail of the plan vanishing at the moment it completes
 *  - board churn (domains resting and returning) turning into owner mail
 */

import { buildOutlook, foldOutlook, pruneOutlook, ledgerKey } from "../lib/senders/outlook";
import type { OutlookInput, OutlookLedger, OutlookStep, KeeperSnap, StandingSnap } from "../lib/senders/outlook";

let failures = 0;
let checks = 0;
function ok(cond: unknown, label: string, detail?: string): void {
  checks++;
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
}
function group(name: string): void { console.log(`\n${name}`); }

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-15T12:00:00Z");   // deliberately far past every forecast
const CUT = Date.parse("2026-08-20T16:40:26Z");

const standingClean: StandingSnap = {
  at: new Date(NOW - 10 * 60_000).toISOString(),
  newIp: "173.254.242.194", rulePos1: true, egressSeen: "173.254.242.194", oldIpMentions: 0,
  receivers: { google: { accepted: 300, rejected: 2, deferred: 0 }, microsoft: { accepted: 90, rejected: 0, deferred: 0 }, other: { accepted: 40, rejected: 0, deferred: 0 } },
  dnsbl: { "zen.spamhaus.org": "clean" },
};
const keeperAtTop: KeeperSnap = {
  at: new Date(NOW - 20 * 60_000).toISOString(), lastRun: new Date(NOW - 20 * 60_000).toISOString(),
  rung: 4, rungs: 4, target: 35, due: 4, down: [], hold: [], boxes: 75, atTarget: 75,
};

function input(over: Partial<OutlookInput> = {}): OutlookInput {
  return {
    now: NOW,
    workspaceId: "ws_test", fleet: "internal", fleetName: "Internal server (test)",
    domains: new Set(["a.com"]),
    domainBoxes: new Map([["a.com", { boxes: 5, cap: 100 }]]),
    boxes: { total: 75, active: 0, warming: 75, paused: 0, error: 0, benched: 0 },
    capacity: { today: 120, benched: 0, atFullRamp: 1500 },
    coldToday: 0, sentToday: 0, activatedBoxes: 0,
    graduationAt: Date.parse("2026-08-27T00:00:00Z"),
    rest: { domains: { "a.com": { state: "resting", reason: "12 bounces against 40 sends", until: "2026-08-23T00:00:00Z" } } },
    blocking: ["google"],
    blocks: { blocks: { "internal|google": { fleet: "internal", provider: "google", count: 4279, lastSeen: "2026-08-20T16:21:44Z" } } },
    egress: { cutoverAt: new Date(CUT).toISOString(), egressIp: "173.254.242.194", warmupRamp: [{ afterDays: 0, perDay: 8 }, { afterDays: 7, perDay: 14 }, { afterDays: 11, perDay: 20 }] },
    standing: null, keeper: null, records: {},
    ...over,
  };
}
const byId = (steps: OutlookStep[], id: string) => steps.find((s) => s.id === id);

/* ---------------------------------------------------------------- the promise */

group("no milestone checks off on a date alone");
{
  // Every forecast is weeks in the past and NO evidence source is present.
  const { steps } = buildOutlook(input());
  ok(steps.length > 0, "the plan is drawn even with no evidence");
  const done = steps.filter((s) => s.done);
  ok(done.length === 0, "nothing is done without evidence", `checked off: ${done.map((s) => s.id).join(", ")}`);
  const rung = byId(steps, "warmup:14")!;
  ok(rung.state === "unverified", "a warm-up rung with no keeper report is unverified, not done", `state=${rung.state}`);
  ok(!!rung.blocker, "an unverified rung says why it cannot be confirmed");
  const grad = byId(steps, "graduation")!;
  ok(grad.state === "late" && !grad.done, "a graduation past its date with no activation is late", `state=${grad.state}`);
  ok(/0 of 75 boxes are active/.test(grad.blocker || ""), "the late line says what it is waiting on", grad.blocker || "");
}

group("evidence, and only evidence, checks a milestone off");
{
  const { steps } = buildOutlook(input({
    standing: standingClean, keeper: keeperAtTop,
    boxes: { total: 75, active: 75, warming: 0, paused: 0, error: 0, benched: 0 },
    activatedBoxes: 75, capacity: { today: 1500, benched: 0, atFullRamp: 1500 }, coldToday: 400, sentToday: 380,
    blocking: [], rest: { domains: { "a.com": { state: "cleared", history: [{ at: "2026-09-10T00:00:00Z", event: "cleared" }] } } },
    // Healed inside the news window: the pair was material, the rejections stopped.
    blocks: { blocks: { "internal|google": { fleet: "internal", provider: "google", count: 4279, lastSeen: "2026-09-04T00:00:00Z" } } },
  }));
  for (const id of ["cutover", "graduation", "applane:w1", "applane:w3", "coldlane", "warmup:14", "warmup:20", "domain:a.com", "block:google"]) {
    const s = byId(steps, id);
    ok(s?.done === true, `${id} checks off on real evidence`, s ? `state=${s.state} blocker=${s.blocker}` : "step missing");
    ok(!!s?.proof, `${id} carries the proof that closed it`);
  }
}

group("a partly applied rung is not a reached rung");
{
  const half: KeeperSnap = { ...keeperAtTop, atTarget: 40 };            // 40 of 75 boxes moved
  const { steps } = buildOutlook(input({ standing: standingClean, keeper: half }));
  const rung = byId(steps, "warmup:14")!;
  ok(!rung.done && rung.state === "unverified", "a half-rolled-out rung stays unchecked", `state=${rung.state}`);
  ok(/40 of 75/.test(rung.blocker || ""), "it reports the roll-out it can see", rung.blocker || "");
}

group("an unreadable or census-less keeper report never checks a rung off");
{
  const broken: KeeperSnap = { lastRun: new Date(NOW - 20 * 60_000).toISOString(), error: "smartlead 502" };
  const a = byId(buildOutlook(input({ keeper: broken })).steps, "warmup:14")!;
  ok(!a.done && a.state === "unverified", "an unreadable report is unverified", `state=${a.state}`);
  ok(/unreadable/.test(a.blocker || ""), "and says so", a.blocker || "");

  const noCensus: KeeperSnap = { ...keeperAtTop, boxes: undefined, atTarget: undefined, error: "smartlead 429" };
  const b = byId(buildOutlook(input({ keeper: noCensus })).steps, "warmup:14")!;
  ok(!b.done, "a rung with no box count is not confirmed", `state=${b.state}`);

  const stale: KeeperSnap = { ...keeperAtTop, lastRun: new Date(NOW - 9 * 3_600_000).toISOString() };
  const c = byId(buildOutlook(input({ keeper: stale })).steps, "warmup:14")!;
  ok(!c.done && c.state === "unverified", "a stale keeper report is unverified", `state=${c.state}`);
}

group("the cutover reads the host, not the calendar");
{
  const pinGone: StandingSnap = { ...standingClean, rulePos1: false };
  const a = byId(buildOutlook(input({ standing: pinGone })).steps, "cutover")!;
  ok(!a.done, "a lost SNAT pin leaves the cutover unchecked");

  const oldIp: StandingSnap = { ...standingClean, oldIpMentions: 4 };
  const b = byId(buildOutlook(input({ standing: oldIp })).steps, "cutover")!;
  ok(!b.done, "receivers still naming the old IP leave the cutover unchecked");

  const staleMonitor: StandingSnap = { ...standingClean, at: new Date(NOW - 5 * 3_600_000).toISOString() };
  const c = byId(buildOutlook(input({ standing: staleMonitor })).steps, "cutover")!;
  ok(!c.done && c.state === "unverified", "a stale standing monitor cannot confirm the cutover", `state=${c.state}`);
}

group("a receiver that never blocked us never gets a milestone");
{
  const immaterial = { blocks: { "internal|proofpoint": { fleet: "internal", provider: "proofpoint", count: 19, lastSeen: "2026-09-14T00:00:00Z" } } };
  const { steps } = buildOutlook(input({ blocking: [], blocks: immaterial }));
  ok(!byId(steps, "block:proofpoint"), "a pair under the routing threshold is not a milestone");
}

group("a domain is only back when its boxes are drawing again");
{
  const cleared = { domains: { "a.com": { state: "cleared", history: [{ at: "2026-09-10T00:00:00Z", event: "cleared" }] } } };
  const idle = buildOutlook(input({ rest: cleared, domainBoxes: new Map() }));
  const s = byId(idle.steps, "domain:a.com")!;
  ok(!s.done, "out of rest but drawing nothing is not a revival", `state=${s.state}`);
  ok(/none of its boxes/.test(s.blocker || ""), "and it says which half is missing", s.blocker || "");
}

/* ------------------------------------------------------------------- history */

group("proven, then contradicted");
{
  let ledger: OutlookLedger = {};
  const run = (over: Partial<OutlookInput>) => {
    const built = buildOutlook(input({ ...over, records: ledger.records || {} }));
    const folded = foldOutlook(ledger, { workspaceId: "ws_test", fleet: "internal", fleetName: "t", now: NOW }, built.steps);
    ledger = folded.ledger;
    return { steps: built.steps, events: folded.events };
  };

  const first = run({ standing: standingClean, keeper: keeperAtTop });
  ok(byId(first.steps, "cutover")!.done, "run 1 proves the cutover");
  ok(first.events.some((e) => e.kind === "completed" && e.id === "cutover" && e.notify), "run 1 raises it once, notifiably");

  const second = run({ standing: standingClean, keeper: keeperAtTop });
  ok(!second.events.length, "run 2 on identical evidence raises nothing", JSON.stringify(second.events));

  const third = run({ standing: { ...standingClean, rulePos1: false }, keeper: keeperAtTop });
  const cut3 = byId(third.steps, "cutover")!;
  ok(cut3.regressed && cut3.state === "late", "losing the pin marks the cutover as gone backwards", `state=${cut3.state}`);
  ok(cut3.firstVerifiedAt != null, "it remembers when it was first proven");
  ok(third.events.some((e) => e.kind === "regressed" && e.notify), "a regression on a notifiable milestone pages");

  const fourth = run({ standing: { ...standingClean, rulePos1: false }, keeper: keeperAtTop });
  ok(!fourth.events.some((e) => e.kind === "regressed"), "the same regression does not page twice");

  const fifth = run({ standing: { ...standingClean, at: new Date(NOW - 6 * 3_600_000).toISOString() }, keeper: keeperAtTop });
  const cut5 = byId(fifth.steps, "cutover")!;
  ok(cut5.done && !cut5.regressed, "a monitor going quiet is NOT counter-evidence", `state=${cut5.state}`);
  ok(!!cut5.blocker && !!cut5.proof, "it stands on the older proof and shows the pending re-check");
}

group("board churn stays on the board");
{
  let ledger: OutlookLedger = {};
  const sac = (rest: OutlookInput["rest"]) => {
    const built = buildOutlook(input({
      fleet: "sendingac", fleetName: "Sending.ac", domains: new Set(["d1.com"]),
      domainBoxes: new Map([["d1.com", { boxes: 3, cap: 6 }]]), rest, records: ledger.records || {},
    }));
    const folded = foldOutlook(ledger, { workspaceId: "ws_test", fleet: "sendingac", fleetName: "Sending.ac", now: NOW }, built.steps);
    ledger = folded.ledger;
    return folded.events;
  };
  const revived = sac({ domains: { "d1.com": { state: "cleared", history: [{ at: "2026-09-10T00:00:00Z", event: "cleared" }] } } });
  ok(revived.some((e) => e.kind === "completed"), "a domain coming back is recorded");
  ok(!revived.some((e) => e.notify), "but a domain revival never mails the owner", JSON.stringify(revived.filter((e) => e.notify)));

  const rebenched = sac({ domains: { "d1.com": { state: "resting", reason: "bounces", until: "2026-09-30T00:00:00Z" } } });
  ok(rebenched.some((e) => e.kind === "regressed"), "a re-benched domain un-checks itself");
  ok(!rebenched.some((e) => e.notify), "and still does not mail the owner");
}

group("a date that moves is recorded as a slip");
{
  let ledger: OutlookLedger = {};
  const withUntil = (until: string) => {
    const built = buildOutlook(input({
      rest: { domains: { "a.com": { state: "resting", reason: "bounces", until } } }, records: ledger.records || {},
    }));
    const folded = foldOutlook(ledger, { workspaceId: "ws_test", fleet: "internal", fleetName: "t", now: NOW }, built.steps);
    ledger = folded.ledger;
    return folded.events;
  };
  withUntil("2026-09-20T00:00:00Z");
  const moved = withUntil("2026-09-27T00:00:00Z");
  ok(moved.some((e) => e.kind === "slipped"), "a rest extension is a slip");
  const again = withUntil("2026-09-27T00:00:00Z");
  ok(!again.some((e) => e.kind === "slipped"), "an unchanged date is not a slip");
  const rec = (ledger.records || {})[ledgerKey("ws_test", "internal", "domain:a.com")];
  ok(rec?.slips === 1, "the slip is counted once", `slips=${rec?.slips}`);
}

group("the finished tail of the plan stays on the board");
{
  let ledger: OutlookLedger = {};
  const warming = buildOutlook(input({ standing: standingClean, keeper: keeperAtTop }));
  ledger = foldOutlook(ledger, { workspaceId: "ws_test", fleet: "internal", fleetName: "t", now: NOW }, warming.steps).ledger;
  ok(!!byId(warming.steps, "graduation"), "the graduation is on the plan while boxes warm");

  // Every box graduated: the age clock that produced the date no longer exists.
  const after = buildOutlook(input({
    standing: standingClean, keeper: keeperAtTop, graduationAt: null,
    boxes: { total: 75, active: 75, warming: 0, paused: 0, error: 0, benched: 0 },
    activatedBoxes: 75, capacity: { today: 1500, benched: 0, atFullRamp: 1500 },
    records: ledger.records || {},
  }));
  const grad = byId(after.steps, "graduation");
  ok(!!grad, "the graduation line survives the clock that drew it");
  ok(grad?.done === true, "and reads as done");
  ok(!!byId(after.steps, "applane:w3"), "so does the ramp that followed it");
}

group("the ledger does not grow without bound");
{
  const old = new Date(NOW - 200 * DAY).toISOString();
  const led: OutlookLedger = { records: {
    "ws::internal::keep": { id: "keep", checkedAt: new Date(NOW).toISOString() },
    "ws::internal::stale": { id: "stale", checkedAt: old },
    "ws::internal::seen-but-old": { id: "seen-but-old", checkedAt: old },
  } };
  const { ledger, pruned } = pruneOutlook(led, new Set(["ws::internal::seen-but-old"]), NOW);
  ok(pruned === 1, "a record nothing reports any more is dropped", `pruned=${pruned}`);
  ok(!!ledger.records?.["ws::internal::seen-but-old"], "a record still reported is kept however old");
  ok(!!ledger.records?.["ws::internal::keep"], "a fresh record is kept");
}

group("the plan is bounded, and every trim says so");
{
  const many: Record<string, { state: string; reason: string; until: string }> = {};
  const doms = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const d = `d${String(i).padStart(2, "0")}.com`;
    doms.add(d);
    many[d] = { state: "resting", reason: "bounces", until: new Date(NOW + (i + 1) * DAY).toISOString() };
  }
  const { steps } = buildOutlook(input({ fleet: "sendingac", domains: doms, domainBoxes: new Map(), rest: { domains: many } }));
  ok(steps.length <= 16, "a 40-domain fleet does not draw 40 lines", `lines=${steps.length}`);
  const more = byId(steps, "domains:resting-more");
  ok(!!more, "the trimmed remainder is stated, not dropped");
  ok(/28 more/.test(more?.what || ""), "and it says how many", more?.what || "");
  ok(!more?.done, "the remainder line is not a check-off");
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.error(`${failures} FAILED - the fleet plan would check something off it cannot prove`); process.exit(1); }
