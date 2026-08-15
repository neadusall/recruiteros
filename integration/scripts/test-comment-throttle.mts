/**
 * The public-comment lane's throttle, exercised against the real module.
 *
 * What this proves: the day allowance actually varies day to day and stays
 * inside the jitter band, the weekly ceiling is hard, the spacing gate holds
 * a second comment back, and the near-duplicate guard catches a reworded
 * repeat. Run: npx tsx scripts/test-comment-throttle.mts
 */
import assert from "node:assert";
import {
  commentThrottleFor, setCommentLimits, commentLimitsFor,
  __throttleTestHooks as hooks,
} from "../lib/linkedin/commentWatch";

const WS = "ws_throttle_test";
let failures = 0;
function check(name: string, fn: () => void): void {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) {
    failures++;
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

console.log("comment throttle");

check("defaults are the documented ones", () => {
  const l = commentLimitsFor(WS);
  assert.equal(l.enabled, true);
  // Owner spec 2026-08-15: 8 to 10 a day. The week has to clear seven days of
  // that or it silently becomes the real limit instead of the day.
  assert.equal(l.perDay, 9);
  assert.equal(l.perWeek, 63);
});

check("the day allowance varies across days and stays in the jitter band", () => {
  const seen = new Set<number>();
  for (let i = 0; i < 30; i++) {
    const day = new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10);
    const a = hooks.dayAllowanceFor(WS, day);
    assert.ok(a >= 8 && a <= 10, `allowance ${a} outside the asked-for 8 to 10 band`);
    seen.add(a);
  }
  // The band is the spec, so there are only three values to draw from; what
  // still matters is that the number is not the same every single day.
  assert.ok(seen.size >= 2, `only ${seen.size} distinct allowances in 30 days: not varied enough`);
});

check("the same day always returns the same allowance", () => {
  const a = hooks.dayAllowanceFor(WS, "2026-08-14");
  for (let i = 0; i < 20; i++) assert.equal(hooks.dayAllowanceFor(WS, "2026-08-14"), a);
});

check("a fresh workspace is clear to comment", () => {
  const t = commentThrottleFor(WS);
  assert.equal(t.blockedReason, undefined);
  assert.equal(t.todayUsed, 0);
});

check("one comment trips the spacing gate", () => {
  hooks.setLog(WS, [new Date().toISOString()]);
  const t = commentThrottleFor(WS);
  assert.ok(t.blockedReason && /Spacing/.test(t.blockedReason), `expected a spacing hold, got ${t.blockedReason}`);
  assert.ok(t.nextSlotAt, "spacing hold must say when the next slot opens");
  const gap = (new Date(t.nextSlotAt as string).getTime() - Date.now()) / 60_000;
  assert.ok(gap > 0 && gap <= 95, `next slot ${gap} minutes away, outside the 24 to 95 band`);
});

check("the day allowance is a wall, and it outranks the spacing message", () => {
  // Anchored at noon UTC so every entry lands on today's date whatever hour
  // the suite runs at; the day wall is checked before spacing, so a full day
  // must report the allowance, not a gap.
  const day = new Date().toISOString().slice(0, 10);
  const noon = Date.parse(`${day}T12:00:00.000Z`);
  const allowance = hooks.dayAllowanceFor(WS, day);
  hooks.setLog(WS, Array.from({ length: allowance }, (_, i) =>
    new Date(noon - (allowance - i) * 180_000).toISOString()));
  const t = commentThrottleFor(WS);
  assert.equal(t.todayUsed, allowance);
  assert.ok(t.blockedReason && /allowance is used/.test(t.blockedReason), `got ${t.blockedReason}`);
});

check("the weekly ceiling is hard and outranks the day", () => {
  // Spread across the last 6 days so no single day is over its allowance.
  const now = Date.now();
  hooks.setLog(WS, Array.from({ length: 63 }, (_, i) =>
    new Date(now - (i + 1) * 2 * 3_600_000).toISOString()));
  const t = commentThrottleFor(WS);
  assert.equal(t.weekUsed, 63);
  assert.ok(t.blockedReason && /Weekly/.test(t.blockedReason), `got ${t.blockedReason}`);
});

check("comments older than a week roll off the weekly count", () => {
  const old = Date.now() - 9 * 86_400_000;
  hooks.setLog(WS, Array.from({ length: 35 }, (_, i) => new Date(old - i * 3_600_000).toISOString()));
  const t = commentThrottleFor(WS);
  assert.equal(t.weekUsed, 0);
  assert.equal(t.blockedReason, undefined);
});

check("switching the lane off blocks everything", async () => {
  hooks.setLimits(WS, { enabled: false, perDay: 8, perWeek: 35 });
  const t = commentThrottleFor(WS);
  assert.equal(t.enabled, false);
  assert.ok(t.blockedReason && /switched off/.test(t.blockedReason));
  hooks.setLimits(WS, { enabled: true, perDay: 8, perWeek: 35 });
});

check("the near-duplicate guard catches a reworded repeat", () => {
  const posted = "Licensing is usually the bottleneck on these searches, not the clinical bar itself.";
  const reworded = "Licensing is usually the bottleneck on searches like these, not really the clinical bar.";
  const different = "Curious whether you are open to candidates relocating, or holding to the local market.";
  assert.equal(hooks.tooSimilar(reworded, [posted]), true, "reworded repeat slipped through");
  assert.equal(hooks.tooSimilar(different, [posted]), false, "a genuinely different comment was rejected");
});

check("a week cap below the day base is raised, never left unreachable", async () => {
  const l = await setCommentLimits(WS, { perDay: 10, perWeek: 3 });
  assert.ok(l.perWeek >= l.perDay, `perWeek ${l.perWeek} below perDay ${l.perDay}`);
});

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
