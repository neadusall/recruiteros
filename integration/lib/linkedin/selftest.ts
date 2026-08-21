/**
 * RecruitersOS · LinkedIn outreach · selftest
 *
 * Run: npx tsx lib/linkedin/selftest.ts     (no network, no credentials)
 *
 * Two things are pinned here, both born from one real reply on 2026-08-21. We
 * DM'd a Finance Director offering candidates for an opening we had invented,
 * and he answered: "I don't know where you are getting your data but I am not
 * hiring but I am looking for work."
 *
 * Two independent faults produced that message, so there are two suites:
 *
 *  1. He was job-hunting, and his profile said so in a field we had already
 *     fetched and thrown away. jobSeekerVerdict is now the gate, and the cases
 *     below are as much about what must NOT match as what must: a hiring manager
 *     whose headline says "hiring a Controller, open to referrals" being
 *     silently discarded is a worse bug than the one being fixed, because a lost
 *     lead leaves no trace and a bad send at least gets a reply.
 *
 *  1b. Owner ask, same day: verify CURRENT EMPLOYMENT against the company we are
 *     writing about, instead of trusting a headline. This turned out to be the
 *     stronger check -- his most recent role had ended six weeks earlier and not
 *     one of his eleven roles was open-ended, while his headline still read
 *     "Finance Director". The fixture in suite 6 is that real history.
 *
 *  2. The message claimed "Saw the news about the team growing" to a man who had
 *     posted about cash-flow reporting. That was not a bad draft, it was a
 *     mis-wiring: a scenario matching on SUBJECT MATTER was pointed at a bank of
 *     templates that assert an ANNOUNCEMENT. assertScenarioBanks() makes that
 *     class of pairing a build failure instead of a live send.
 */

import { jobSeekerVerdict } from "../outreach/jobSeeker";
import { employmentVerdict, notABuyerReason, parseWorkDate, sameCompany } from "../outreach/employment";
import { assertScenarioBanks, SCENARIO_PRESETS } from "./commentWatch";

let pass = 0;
const failures: string[] = [];

function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  failures.push(`${label}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`);
}

function seeker(label: string, input: Parameters<typeof jobSeekerVerdict>[0], want: boolean): void {
  check(label, jobSeekerVerdict(input).isSeeker, want);
}

/* ---------------------------------------------------------------- 1. flag -- */

seeker("open-to-work flag alone is decisive",
  { openToWorkFlag: true, headline: "Finance Director | FP&A, Budgeting & Forecasting Leader" }, true);

// The real profile from the incident: a strong, employed-sounding headline with
// the badge switched on. Headline text alone would never have caught it, which
// is exactly why the flag is checked first.
seeker("the Friedle case: flag set, headline reads as employed",
  {
    openToWorkFlag: true,
    headline: "Finance Director | FP&A, Budgeting & Forecasting Leader | 3-Statement Modeling, Power BI & Capital Allocation | Driving Profitability & Cash Visibility Across Multi-Site Organizations",
  }, true);

// The badge is off by default and most people never touch it, so a false flag
// proves nothing and the text must still be read.
seeker("flag false does not stop the text check",
  { openToWorkFlag: false, headline: "CFO | #OpenToWork" }, true);

/* ---------------------------------------------------------------- 2. text -- */

seeker("hash tag", { headline: "Senior Controller | #OpenToWork" }, true);
seeker("spaced out", { headline: "Open To Work | Finance leader" }, true);
seeker("open to new roles", { headline: "Finance Director, open to new roles" }, true);
seeker("seeking my next role", { headline: "FP&A leader seeking my next role" }, true);
seeker("looking for a new opportunity", { summary: "Currently looking for a new opportunity in finance." }, true);
seeker("actively interviewing", { summary: "Actively interviewing for Director-level finance roles." }, true);
seeker("in transition", { headline: "Finance executive in transition" }, true);
seeker("between roles", { summary: "Between roles after an acquisition." }, true);
seeker("available for hire", { headline: "Fractional CFO, available for hire" }, true);
seeker("recently laid off", { summary: "Recently laid off from a multi-site operator." }, true);
seeker("job seeker", { headline: "Job Seeker | Accounting" }, true);

/* ------------------------------------------------- 3. must NOT match ------- */

seeker("plain employed director", { headline: "Finance Director at Northwind" }, false);
seeker("the exact incident headline WITHOUT the flag",
  { headline: "Finance Director | FP&A, Budgeting & Forecasting Leader | 3-Statement Modeling, Power BI & Capital Allocation" }, false);

// The expensive false positives: hiring managers using seeker-adjacent words.
seeker("hiring manager open to referrals", { headline: "CFO | hiring a Controller, open to referrals" }, false);
seeker("looking for candidates, not a job", { summary: "We are looking for a Director of Finance to join us." }, false);
seeker("seeking candidates", { summary: "Seeking experienced FP&A analysts for our Phoenix office." }, false);
seeker("open to opportunities to partner", { headline: "Founder | open to opportunities to partner with great teams" }, false);
seeker("available on the team", { summary: "We have a seat available on the finance team." }, false);
seeker("growth talk", { headline: "VP Finance | scaling our team from 12 to 30" }, false);
seeker("empty input", {}, false);
seeker("whitespace only", { headline: "   ", summary: "" }, false);

/* --------------------------------------------- 4. reason is operator-safe -- */

check("reason names the flag",
  jobSeekerVerdict({ openToWorkFlag: true }).reason,
  "open-to-work flag set on their profile");
check("reason names the field and the phrase",
  jobSeekerVerdict({ headline: "Finance lead, in transition" }).reason,
  "their headline says in transition");
check("source is reported", jobSeekerVerdict({ summary: "#OpenToWork" }).source, "summary");

/* ------------------------------------------- 5. scenario / bank coherence -- */

check("no scenario asserts an event its match does not establish", assertScenarioBanks(), []);

// The specific mis-wiring that caused the incident, pinned so it cannot return.
const industry = SCENARIO_PRESETS.find((p) => p.id === "industry_conversation");
check("industry_conversation exists", Boolean(industry), true);
check("industry_conversation does not claim growth", industry?.dmBank, "peer");
check("industry_conversation still requires no hiring language", industry?.hiringIntent, false);

// The scenarios that MAY claim growth are exactly the ones that look for it.
for (const id of ["team_growth", "new_location", "funding_growth"]) {
  const p = SCENARIO_PRESETS.find((x) => x.id === id);
  check(`${id} keeps the growth bank`, p?.dmBank, "growth");
}

/* ------------------------------------------- 6. employment verification ---- */
/* Owner ask 2026-08-21: check the person's CURRENT EMPLOYMENT against the
   company we are writing about, rather than believing a headline. The fixture
   below is the real work history off the profile that prompted it, dates
   included: eleven roles, not one of them open-ended, the most recent finished
   1 July 2026 while the headline still said "Finance Director". */

const FRIEDLE_WORK = [
  { company: "Frisella Nursery", position: "Finance Director/Controller", start: "1/1/2026", end: "7/1/2026", status: "Full-time" },
  { company: "Save A Lot", position: "Financial Planning and Analysis Manager", start: "2/1/2025", end: "1/1/2026", status: "Full-time" },
  { company: "Centene Corporation", position: "Manager of Financial Planning", start: "4/1/2024", end: "2/1/2025", status: "Full-time" },
  { company: "Charter Communications", position: "Sr Product Delivery Manager (Finance)", start: "9/1/2022", end: "4/1/2024", status: "Full-time" },
];

const friedle = employmentVerdict({ work: FRIEDLE_WORK });
check("the real case reads as not employed", friedle.status, "not_employed");
check("and dates the last role correctly", friedle.lastRoleEndedAt, "2026-07-01");
check("and that is enough to stop the pitch", Boolean(notABuyerReason(friedle)), true);

// Someone employed passes, and we learn where they work.
const employed = employmentVerdict({
  work: [
    { company: "Northwind Health", position: "VP Finance", start: "3/1/2024" },
    { company: "Centene Corporation", position: "Manager FP&A", start: "1/1/2020", end: "3/1/2024" },
  ],
});
check("open-ended role reads as employed", employed.status, "employed");
check("and names the employer", employed.currentCompany, "Northwind Health");
check("and does not block", notABuyerReason(employed), null);

// The stale-headline case: still employed, but not where we thought.
const moved = employmentVerdict({
  work: [
    { company: "Northwind Health", position: "VP Finance", start: "3/1/2026" },
    { company: "Gensler", position: "FP&A Director", start: "1/1/2022", end: "2/1/2026" },
  ],
  claimedCompany: "Gensler",
});
check("left the company we were writing about", moved.leftClaimedCompany, true);
check("and that blocks too", Boolean(notABuyerReason(moved)), true);

// Same employer, written differently, must NOT read as having left.
const sameCo = employmentVerdict({
  work: [{ company: "Acme Corporation", position: "CFO", start: "1/1/2024" }],
  claimedCompany: "Acme Corp.",
});
check("legal suffixes do not fake a departure", sameCo.leftClaimedCompany, undefined);
check("and it still passes", notABuyerReason(sameCo), null);

// UNKNOWN MUST PASS. Work history is often missing from a profile read, and
// blocking everyone we cannot verify would delete most of the lane silently,
// which is a worse failure than the one being prevented.
const unknown = employmentVerdict({ work: [] });
check("no history reads as unknown", unknown.status, "unknown");
check("and unknown never blocks", notABuyerReason(unknown), null);

// Date parsing: only formats we are sure of, otherwise null rather than a guess.
check("M/D/YYYY", parseWorkDate("7/1/2026")?.toISOString().slice(0, 10), "2026-07-01");
check("YYYY-MM", parseWorkDate("2026-07")?.toISOString().slice(0, 10), "2026-07-01");
check("named month", parseWorkDate("Jul 2026")?.toISOString().slice(0, 10), "2026-07-01");
check("full month name", parseWorkDate("January 2026")?.toISOString().slice(0, 10), "2026-01-01");
check("bare year", parseWorkDate("2026")?.toISOString().slice(0, 10), "2026-01-01");
check("nonsense is null, never a guess", parseWorkDate("present"), null);
check("empty is null", parseWorkDate(""), null);

check("company match ignores punctuation", sameCompany("Acme, Inc.", "Acme"), true);
check("company match is not blind", sameCompany("Acme", "Acmetric Health"), false);
check("blank never matches", sameCompany("", "Acme"), false);

/* -------------------------------------------------------------- report ----- */

if (failures.length) {
  console.error(`\n[linkedin selftest] ${pass} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.error("  x " + f + "\n");
  process.exit(1);
}
console.log(`[linkedin selftest] ${pass} assertions passed`);
