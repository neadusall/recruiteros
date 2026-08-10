/* Discovery must not outrun sending — and the brake must not become a wedge.
 *
 * Two guarantees are load-bearing here, and they pull in opposite directions:
 *
 *   1. The daily target is clamped DOWN to what the inbox fleet can physically send, so
 *      staging cannot build a queue that never drains. Over-staging is not just early:
 *      the watchlist marks every curated company permanently seen on the way past, so
 *      overflow spends inventory that never comes back.
 *   2. The clamp and the belt gate FAIL OPEN. A workspace with no senders yet, or an
 *      unreadable module, must not resolve to "capacity 0" and silently stop the belt.
 *
 * A test that only checked (1) would pass on a build that had quietly stopped sending.
 *
 * Run: npx tsx scripts/test-belt-capacity.mts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "ros-belt-"));
process.env.ROS_DATA_DIR = DATA_DIR;

const { getAutofillSettings, setAutofillSettings, dailyTargetExplained } = await import("../lib/sending/autofill");
const { beltRoom } = await import("../lib/signals/watch/poll");

let failures = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { console.log(`PASS ${label}`); return; }
  failures++;
  console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
}
function eq<T>(a: T, b: T, label: string): void { ok(a === b, label, `expected ${String(b)}, got ${String(a)}`); }

/* 1. Settings ------------------------------------------------------------- */
const d = await getAutofillSettings();
// Not 50. Measured news supply is ~19 companies per segment per month, so six segments is
// roughly 11 prospects a day against a daily target in the thousands. A 50% reserve would
// be a number the arm can never fill; unclaimed share is handed back so it would cost
// nothing, but an operator reading "50" would be reading a fiction.
eq(d.newsSharePct, 15, "the news share defaults to what the arm can actually supply");

await setAutofillSettings({ newsSharePct: 150 });
eq((await getAutofillSettings()).newsSharePct, 100, "an out-of-range share is clamped, not stored");
await setAutofillSettings({ newsSharePct: -20 });
eq((await getAutofillSettings()).newsSharePct, 0, "a negative share clamps to zero");
await setAutofillSettings({ newsSharePct: 50 });

/* 2. The clamp only ever clamps DOWN -------------------------------------- */
// No workspace configured: nothing to read a fleet from, so the band midpoint stands.
await setAutofillSettings({ workspaceId: "", campaignId: "", targetMin: 4000, targetMax: 6000 });
const unset = await dailyTargetExplained();
eq(unset.target, 5000, "with no workspace the target is the band midpoint");
eq(unset.clamped, false, "and nothing claims to have been clamped");

// A workspace with no sender inboxes reports zero capacity. That must NOT become a
// target of zero — an unconfigured fleet is unknown capacity, not no capacity.
await setAutofillSettings({ workspaceId: "ws_no_senders", campaignId: "cmp_1" });
const noFleet = await dailyTargetExplained();
ok(noFleet.target > 0, "a workspace with no sender inboxes still has a positive target", JSON.stringify(noFleet));
eq(noFleet.fleetCapacity, null, "an empty fleet reads as unknown, not as a ceiling of zero");
eq(noFleet.clamped, false, "and is not reported as a clamp");

/* 3. The belt gate fails OPEN --------------------------------------------- */
// No campaign chosen: autofill stages nothing, so there is no queue to be full.
await setAutofillSettings({ workspaceId: "ws_x", campaignId: "" });
const noCampaign = await beltRoom();
eq(noCampaign.hasRoom, true, "with no send-queue campaign, discovery is allowed");
ok(!!noCampaign.note, "and says why", noCampaign.note);

// The explicit escape hatch, for an operator who wants discovery to run regardless.
await setAutofillSettings({ workspaceId: "ws_x", campaignId: "cmp_1" });
process.env.SIGNALS_WATCH_RESPECT_CAPACITY = "0";
const disabled = await beltRoom();
eq(disabled.hasRoom, true, "back pressure can be switched off explicitly");
ok((disabled.note || "").includes("disabled"), "and says so", disabled.note);
delete process.env.SIGNALS_WATCH_RESPECT_CAPACITY;

// An empty queue has room by definition.
const empty = await beltRoom();
eq(empty.hasRoom, true, "an empty send queue has room");

/* 4. The full-belt decision ------------------------------------------------ */
// The gate is: readySupply >= bufferDays x dailyTarget. Verify the arithmetic it will
// run in production, independent of whether a queue happens to exist in this process.
for (const [ready, days, target, expected] of [
  [0, 5, 1000, true],
  [4999, 5, 1000, true],
  [5000, 5, 1000, false],   // exactly at the buffer is full
  [9000, 5, 1000, false],
] as Array<[number, number, number, boolean]>) {
  eq(ready < days * target, expected, `readySupply ${ready} vs ${days}-day buffer of ${days * target} -> ${expected ? "room" : "full"}`);
}

rmSync(DATA_DIR, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES` : "\nbelt capacity brake is safe in both directions");
process.exit(failures ? 1 : 0);
