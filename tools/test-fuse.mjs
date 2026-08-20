// Tests for the send fuse. Plain node: node tools/test-fuse.mjs
// Guards: the fleet fuse trips on a real spike and LATCHES, never on thin samples; a clear restarts
// the count; a bouncing source pauses alone and escalates; the slice is stable; infra errors are
// not sends.
import assert from "node:assert/strict";
import { evaluateFuse, emptyLedger, clearFleet, tripFleet, canarySlice, tierOf, isRealSend, DEFAULTS } from "./fuse.mjs";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.error("FAIL " + name); console.error(e && e.stack || e); process.exitCode = 1; }
}
const HOUR = 3_600_000, DAY = 86_400_000;
const now = Date.parse("2026-08-20T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const config = { ...DEFAULTS };

function sends(n, { agoMs = 30 * 60_000, source = "koldinfo", from = "ryan@lumeone.com", ok = true } = {}) {
  return Array.from({ length: n }, (_, i) => ({ at: iso(now - agoMs - i * 1000), to_email: `p${i}.${source}@co${i % 7}.com`, from, email_source: source, result: ok ? { ok: true } : { ok: false, error: "404: no such mailbox" } }));
}
function notices(n, { agoMs = 10 * 60_000, source = "koldinfo", reason = "dead_address" } = {}) {
  return Array.from({ length: n }, (_, i) => ({ at: iso(now - agoMs - i * 1000), rcpt: `p${i}.${source}@co${i % 7}.com`, reason, source }));
}
const ndr = (ns) => ({ generatedAt: iso(now - 5 * 60_000), notices: ns });

test("trips at 6% on 100 sends, latches with reason", () => {
  const { ledger, changes } = evaluateFuse({ ledger: emptyLedger(), sentRows: sends(100), ndr: ndr(notices(6)), now, config });
  assert.equal(ledger.fleet.tripped, true);
  assert.equal(ledger.fleet.by, "auto");
  assert.match(ledger.fleet.reason, /6\.0%/);
  assert.equal(changes.filter((c) => c.kind === "fleet_tripped").length, 1);
  assert.deepEqual(ledger.fleet.domains, ["lumeone.com"]);
});
test("does not trip at 4% on 100 sends", () => {
  const { ledger } = evaluateFuse({ ledger: emptyLedger(), sentRows: sends(100), ndr: ndr(notices(4)), now, config });
  assert.equal(ledger.fleet.tripped, false);
  assert.equal(ledger.window.sends, 100); assert.equal(ledger.window.bounces, 4);
});
test("does not trip below the 100-send floor, however bad the ratio", () => {
  const { ledger } = evaluateFuse({ ledger: emptyLedger(), sentRows: sends(50), ndr: ndr(notices(20)), now, config });
  assert.equal(ledger.fleet.tripped, false);
});
test("relay_auth notices (our box could not send) never count", () => {
  const { ledger } = evaluateFuse({ ledger: emptyLedger(), sentRows: sends(100), ndr: ndr(notices(9, { reason: "relay_auth" })), now, config });
  assert.equal(ledger.fleet.tripped, false); assert.equal(ledger.window.bounces, 0);
});
test("sends and bounces outside the 24h window are ignored", () => {
  const { ledger } = evaluateFuse({ ledger: emptyLedger(), sentRows: sends(100, { agoMs: 30 * HOUR }), ndr: ndr(notices(30, { agoMs: 30 * HOUR })), now, config });
  assert.equal(ledger.window.sends, 0); assert.equal(ledger.fleet.tripped, false);
});
test("a tripped fuse stays tripped on clean data (latched)", () => {
  const led = emptyLedger(); tripFleet(led, { by: "auto", reason: "x", now: now - 2 * HOUR });
  const { ledger, changes } = evaluateFuse({ ledger: led, sentRows: sends(100), ndr: ndr([]), now, config });
  assert.equal(ledger.fleet.tripped, true); assert.equal(changes.length, 0);
});
test("after a clear, only bounces (and sends) after clearedAt count", () => {
  const led = emptyLedger(); tripFleet(led, { by: "auto", reason: "x", now: now - 3 * HOUR });
  clearFleet(led, { by: "owner", now: now - HOUR });
  // the old spike is entirely before clearedAt: no re-trip
  let r = evaluateFuse({ ledger: led, sentRows: sends(120, { agoMs: 2 * HOUR }), ndr: ndr(notices(12, { agoMs: 2 * HOUR })), now, config });
  assert.equal(r.ledger.fleet.tripped, false); assert.equal(r.ledger.window.bounces, 0);
  // a fresh spike after clearedAt re-trips
  r = evaluateFuse({ ledger: r.ledger, sentRows: sends(120, { agoMs: 30 * 60_000 }), ndr: ndr(notices(8, { agoMs: 10 * 60_000 })), now, config });
  assert.equal(r.ledger.fleet.tripped, true);
});
test("no notices in the sweep yet: window unavailable, nothing trips", () => {
  const { ledger } = evaluateFuse({ ledger: emptyLedger(), sentRows: sends(200), ndr: { generatedAt: iso(now) }, now, config });
  assert.equal(ledger.window.available, false); assert.equal(ledger.fleet.tripped, false);
});

test("a bouncing source pauses alone (48h); a clean source keeps sending", () => {
  const rows = [...sends(60, { source: "guess" }), ...sends(60, { source: "koldinfo" })];
  const { ledger, changes } = evaluateFuse({ ledger: emptyLedger(), sentRows: rows, ndr: ndr(notices(4, { source: "guess" })), now, config });
  assert.equal(ledger.sources.guess.paused, true);
  assert.equal(Date.parse(ledger.sources.guess.until) - now, 48 * HOUR);
  assert.equal(ledger.sources.koldinfo.paused, false);
  assert.equal(ledger.fleet.tripped, false, "4/120 fleet-wide is under the fuse line");
  assert.equal(changes.filter((c) => c.kind === "source_paused").length, 1);
  assert.equal(ledger.sources.guess.tier, "pattern"); assert.equal(ledger.sources.koldinfo.tier, "found");
});
test("a source under the 30-send floor never pauses", () => {
  const { ledger } = evaluateFuse({ ledger: emptyLedger(), sentRows: sends(20, { source: "guess" }), ndr: ndr(notices(5, { source: "guess" })), now, config });
  assert.equal(ledger.sources.guess.paused, false);
});
test("pre-belt rows with no source are never attributed", () => {
  const rows = sends(100).map((r) => { const { email_source, ...rest } = r; return rest; });
  const { ledger } = evaluateFuse({ ledger: emptyLedger(), sentRows: rows, ndr: ndr(notices(6).map((n) => ({ ...n, source: null }))), now, config });
  assert.deepEqual(Object.keys(ledger.sources), []);
  assert.equal(ledger.fleet.tripped, true, "the fleet fuse still sees them");
});
test("a served pause releases itself and restarts its window; a repeat inside 14d escalates to 7d", () => {
  let r = evaluateFuse({ ledger: emptyLedger(), sentRows: sends(60, { source: "guess", agoMs: 3 * DAY }), ndr: ndr(notices(4, { source: "guess", agoMs: 3 * DAY })), now: now - 3 * DAY, config });
  assert.equal(r.ledger.sources.guess.paused, true);
  // 50h later the pause is served; old notices are still in the 7d window but must not re-pause
  r = evaluateFuse({ ledger: r.ledger, sentRows: sends(60, { source: "guess", agoMs: 3 * DAY }), ndr: ndr(notices(4, { source: "guess", agoMs: 3 * DAY })), now: now - 3 * DAY + 50 * HOUR, config });
  assert.equal(r.ledger.sources.guess.paused, false);
  assert.ok(r.ledger.sources.guess.releasedAt);
  assert.equal(r.ledger.sources.guess.bounces, 0, "bounces before release do not count");
  // a second spike after release: strike 2 -> 168h
  const t2 = now;
  r = evaluateFuse({ ledger: r.ledger, sentRows: sends(60, { source: "guess", agoMs: HOUR }), ndr: ndr(notices(5, { source: "guess", agoMs: 30 * 60_000 })), now: t2, config });
  assert.equal(r.ledger.sources.guess.paused, true);
  assert.equal(Date.parse(r.ledger.sources.guess.until) - t2, 168 * HOUR);
});

test("canary slice is stable, sized ~pct, and independent of which domains are resting", () => {
  const all = Array.from({ length: 20 }, (_, i) => `lume${i}.com`);
  const a = canarySlice(all, 25), b = canarySlice([...all].reverse(), 25);
  assert.deepEqual([...a].sort(), [...b].sort());
  assert.equal(a.size, 5);
  assert.equal(canarySlice(["only.com"], 25).size, 1);
  assert.equal(canarySlice([], 25).size, 0);
});
test("tierOf: finder records are found, everything else is pattern", () => {
  for (const s of ["koldinfo", "reoon_found", "smtp_found", "site_direct"]) assert.equal(tierOf(s), "found", s);
  for (const s of ["guess", "validated_external", "site_pattern", "catch_all", undefined, "harvest:cache(first.last)"]) assert.equal(tierOf(s), "pattern", String(s));
});
test("isRealSend: ok sends count, 404/429 infra failures and SMTP failures do not", () => {
  assert.ok(isRealSend({ to_email: "a@b.c", result: { ok: true } }));
  assert.ok(!isRealSend({ to_email: "a@b.c", result: { ok: false, error: "404: no such mailbox" } }));
  assert.ok(!isRealSend({ to_email: "a@b.c", result: { ok: false, error: "smtp password would not decrypt" } }));
  assert.ok(!isRealSend({ result: { ok: true } }));
});

console.log("\n" + passed + " passed");
