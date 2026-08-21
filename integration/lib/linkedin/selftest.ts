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
 *  2. The message claimed "Saw the news about the team growing" to a man who had
 *     posted about cash-flow reporting. That was not a bad draft, it was a
 *     mis-wiring: a scenario matching on SUBJECT MATTER was pointed at a bank of
 *     templates that assert an ANNOUNCEMENT. assertScenarioBanks() makes that
 *     class of pairing a build failure instead of a live send.
 */

import { jobSeekerVerdict } from "../outreach/jobSeeker";
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

/* -------------------------------------------------------------- report ----- */

if (failures.length) {
  console.error(`\n[linkedin selftest] ${pass} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.error("  x " + f + "\n");
  process.exit(1);
}
console.log(`[linkedin selftest] ${pass} assertions passed`);
