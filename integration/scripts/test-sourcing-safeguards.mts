/* Safeguard tests: geo matcher tolerance + never-empty rescue ladder. */
import { inTargetGeo } from "../lib/sourcing/score";
import { rescueEmptyRun } from "../lib/sourcing/discovery";
import type { CandidateICP, CandidateRow } from "../lib/sourcing/types";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, extra?: unknown) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra ?? ""); }
}

/* ---- 1. inTargetGeo format tolerance (the drop gate) ---- */
ok(inTargetGeo("Dallas, TX", ["Dallas-Fort Worth Metroplex"]) === true, "city vs metro: Dallas, TX in DFW Metroplex");
ok(inTargetGeo("Dallas-Fort Worth Metroplex", ["Dallas, TX"]) === true, "metro vs city: DFW in Dallas, TX");
ok(inTargetGeo("Brooklyn, NY", ["New York"]) === true, "state abbrev expansion still works");
ok(inTargetGeo("Houston, Texas", ["Texas"]) === true, "state-level target matches any city in state");
ok(inTargetGeo("Los Angeles, CA", ["New York"]) === false, "clearly different place still drops");
ok(inTargetGeo(undefined, ["New York"]) === undefined, "no location stays unknown/neutral");
ok(inTargetGeo("Greater Boston Area", ["Boston, MA"]) === true, "greater-area phrasing matches city");

/* ---- 2. rescue ladder ---- */
const icp: CandidateICP = {
  label: "VP Sales", seniority: "vp", managesTeam: true,
  titles: ["VP Sales"], geos: ["New York"], remoteOk: false,
  industries: ["software"], targetCompanies: [], sellsTo: [], verticals: [],
  mustHave: [], niceToHave: [], disqualifiers: ["intern"],
};
const row = (name: string, title: string, location: string): CandidateRow => ({
  fullName: name, title, location, fitScore: 0, fitReasons: [],
  linkedinUrl: "https://linkedin.com/in/" + name.toLowerCase().replace(/\s+/g, ""),
});

// 2a) geo rescue: everyone found is out of area; the run must NOT be empty.
const geoBuf = [
  row("Amy Chen", "VP Sales", "Austin, Texas"),
  row("Bob Diaz", "VP of Sales", "Chicago, Illinois"),
  row("Cara Fox", "Intern", "Miami, Florida"), // disqualified: must never be rescued
];
const r1 = rescueEmptyRun(geoBuf, [], icp, 10, 500);
ok(!!r1 && r1.candidates.length === 2, "geo rescue keeps the qualified out-of-area rows", r1?.candidates.length);
ok(!!r1 && r1.candidates.every((c) => c.outOfArea === true), "rescued rows are marked out of area");
ok(!!r1 && r1.candidates.every((c) => c.fitScore > 0), "no zero-score row is rescued");
ok(!!r1 && !r1.candidates.some((c) => c.fullName === "Cara Fox"), "hard-disqualified row stays out");
ok(!!r1 && /out of area/.test(r1.note) && !/—/.test(r1.note), "note is plain English with no em-dash");

// 2b) fit-bar rescue: fit bar set impossibly high; still shows the strongest found.
const fitBuf = [
  Object.assign(row("Dan Lee", "Sales Manager", "New York, NY"), { fitScore: 32, fitReasons: ["x"] }),
  Object.assign(row("Eve Kim", "Account Exec", "New York, NY"), { fitScore: 21, fitReasons: ["x"] }),
];
const r2 = rescueEmptyRun([], fitBuf, icp, 90, 500);
ok(!!r2 && r2.candidates.length === 2 && r2.candidates[0].fullName === "Dan Lee", "fit-bar rescue returns strongest first", r2?.candidates.map((c) => c.fullName));
ok(!!r2 && /fit bar/.test(r2.note) && !/—/.test(r2.note), "fit-bar note is plain English, no em-dash");

// 2c) geo rows that clear the bar win over fit-bar relaxation (ladder order).
const r3 = rescueEmptyRun([row("Gil Roy", "VP Sales", "Denver, Colorado")], fitBuf, icp, 10, 500);
ok(!!r3 && r3.candidates.some((c) => c.outOfArea), "ladder step 1 (geo) fires before step 2", r3?.note);

// 2d) genuinely nothing worth showing -> null (all disqualified).
const r4 = rescueEmptyRun([row("Hal Poe", "Intern", "Boston, MA")], [], icp, 10, 500);
ok(r4 === null, "all-disqualified stays empty (never fabricates)");

// 2e) geo rescue respects the cap and dedupes by LinkedIn URL.
const dup = row("Ida Q", "VP Sales", "Austin, Texas");
const r5 = rescueEmptyRun([dup, { ...dup }], [], icp, 10, 500);
ok(!!r5 && r5.candidates.length === 1, "duplicate profiles dedupe in rescue", r5?.candidates.length);

// 2f) fit-bar rescue preserves the out-of-area mark, so the UI's location split
// ("Within target area" vs "Outside target area") survives even a rescued run.
const markedBuf = [
  Object.assign(row("Jon Wu", "Sales Manager", "Seattle, Washington"), { fitScore: 30, fitReasons: ["x"], outOfArea: true }),
  Object.assign(row("Kay Orr", "Sales Manager", "New York, NY"), { fitScore: 28, fitReasons: ["x"] }),
];
const r6 = rescueEmptyRun([], markedBuf, icp, 90, 500);
ok(!!r6 && r6.candidates.find((c) => c.fullName === "Jon Wu")?.outOfArea === true
       && !r6.candidates.find((c) => c.fullName === "Kay Orr")?.outOfArea,
   "rescued rows keep their in/out-of-area marks for the split lists");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
