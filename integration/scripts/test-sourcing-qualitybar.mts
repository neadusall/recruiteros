/**
 * Regression suite for the JD Sourcing outreach quality bar.
 *
 *   npx tsx scripts/test-sourcing-qualitybar.mts     (from integration/)
 *
 * Pins the rules that decide who gets CONTACTED, plus the two guarantees that make the
 * bar safe to turn on over a live pipeline: a scoreless row is never dropped, and the
 * bar never touches the saved list itself.
 */

import {
  DEFAULT_DELIVER_MIN_FIT, deliverMinFit, qualifiedForOutreach,
  applyQualityBar, qualityBarNote,
} from "../lib/sourcing/qualityBar";
import type { CandidateRow } from "../lib/sourcing/types";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; } else { failed++; console.error("  FAIL:", name); }
}

function row(fitScore: number | undefined, extra: Partial<CandidateRow> = {}): CandidateRow {
  return { fullName: "Test Person", fitScore: fitScore as number, fitReasons: [], ...extra } as CandidateRow;
}

/* --- the default ---------------------------------------------------------- */
check("default bar is 45", DEFAULT_DELIVER_MIN_FIT === 45);

const savedEnv = process.env.SOURCING_DELIVER_MIN_FIT;
delete process.env.SOURCING_DELIVER_MIN_FIT;
check("no env = default", deliverMinFit() === 45);
process.env.SOURCING_DELIVER_MIN_FIT = "60";
check("env override honored", deliverMinFit() === 60);
process.env.SOURCING_DELIVER_MIN_FIT = "900";
check("absurdly high env clamps to 100, never above", deliverMinFit() === 100);
process.env.SOURCING_DELIVER_MIN_FIT = "-5";
check("negative env clamps to 0 (= off)", deliverMinFit() === 0);
process.env.SOURCING_DELIVER_MIN_FIT = "not a number";
check("garbage env falls back to the default", deliverMinFit() === 45);
if (savedEnv === undefined) delete process.env.SOURCING_DELIVER_MIN_FIT;
else process.env.SOURCING_DELIVER_MIN_FIT = savedEnv;

/* --- the predicate -------------------------------------------------------- */
check("at the bar qualifies (inclusive)", qualifiedForOutreach(row(45), 45));
check("above the bar qualifies", qualifiedForOutreach(row(80), 45));
check("below the bar does not", !qualifiedForOutreach(row(44), 45));
check("well below does not", !qualifiedForOutreach(row(10), 45));
check("zero (hard disqualified) does not", !qualifiedForOutreach(row(0), 45));

// THE SAFETY RULE: an absent score is not evidence of a bad match. Sales Nav imports
// and contact-database sweeps never run the rule scorer, and treating their rows as
// unqualified would silently delete those whole routes from the outreach lane.
check("undefined score is KEPT", qualifiedForOutreach(row(undefined), 45));
check("NaN score is KEPT", qualifiedForOutreach(row(NaN), 45));
check("non-numeric score is KEPT", qualifiedForOutreach(row("high" as any), 45));

// A bar of 0 means off, and must let even a hard-disqualified row through so an
// operator who deliberately sets 0 gets exactly what they asked for.
check("bar 0 = off, everyone qualifies", qualifiedForOutreach(row(0), 0));
check("negative bar = off", qualifiedForOutreach(row(0), -1));

/* --- the split ------------------------------------------------------------ */
const rows = [row(90), row(45), row(44), row(undefined), row(0), row(70)];
const split = applyQualityBar(rows, 45);
check("split keeps the 4 qualifying rows", split.kept.length === 4);
check("split holds back the 2 below-bar rows", split.heldBack.length === 2);
check("split reports the bar it used", split.bar === 45);
check("nothing is lost in the split", split.kept.length + split.heldBack.length === rows.length);
check("the scoreless row landed in kept", split.kept.includes(rows[3]));
check("the 44 landed in heldBack", split.heldBack.includes(rows[2]));

// THE LIST IS NOT MUTATED. The bar governs who is contacted, never what the recruiter
// can see — the same split the radius makes with outOfArea.
check("input array is not mutated", rows.length === 6);
check("input rows are not mutated", rows[2].fitScore === 44);

const allGood = applyQualityBar([row(80), row(90)], 45);
check("all-qualifying list holds nobody back", allGood.heldBack.length === 0 && allGood.kept.length === 2);

const allBad = applyQualityBar([row(10), row(20)], 45);
// NO never-empty fallback here on purpose: rescueEmptyRun already guarantees a search
// never comes back with nobody ON it. When the honest answer is "nobody found here is
// qualified", filling a live campaign with the least-bad rows is the wrong help.
check("all-below list delivers nobody (no filler fallback)", allBad.kept.length === 0);
check("all-below list reports every row held back", allBad.heldBack.length === 2);

const off = applyQualityBar([row(1), row(0)], 0);
check("bar 0 delivers everyone", off.kept.length === 2 && off.heldBack.length === 0);

const empty = applyQualityBar([], 45);
check("empty list is handled", empty.kept.length === 0 && empty.heldBack.length === 0);

check("bar is rounded and clamped inside applyQualityBar", applyQualityBar([row(50)], 150).bar === 100);

/* --- the note ------------------------------------------------------------- */
check("no note when nobody held back", qualityBarNote(0, 45) === undefined);
const note = qualityBarNote(12, 45) ?? "";
check("note states the count", note.includes("12"));
check("note states the bar", note.includes("45"));
check("note says they are still on the list", /still on the list/i.test(note));
// Recruiter-facing copy rules: no score jargon, and no em-dashes anywhere in the app.
check("note carries no score jargon", !/fitScore|minFit|rank|scorer/i.test(note));
check("note has no em-dash", !note.includes("—"));
check("singular reads correctly", (qualityBarNote(1, 45) ?? "").includes("1 person"));
check("plural reads correctly", (qualityBarNote(2, 45) ?? "").includes("2 people"));

console.log(`\nquality-bar suite: ${passed}/${passed + failed} checks passed`);
if (failed) { console.error(`${failed} FAILED`); process.exit(1); }
console.log("all green");
