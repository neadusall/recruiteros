// RecruitersOS · MPC · candidate bank check.
//
// The bank is the only place a real fact about a real person can enter a cold email, so it is
// worth being strict about. This reads the bank the writer would read, resolves each record the
// way matchCandidate() does, and reports what will actually happen when the batch runs.
//
//   node tools/mpc-bank.mjs                      # check /data/mpc-candidates.json
//   node tools/mpc-bank.mjs --bank ./tools/mpc-candidates.example.json
//
// Exits non-zero if any record is unusable, so a deploy step can gate on it.

import { readFileSync } from "node:fs";
import { roleFamily } from "./gates.mjs";

const args = process.argv.slice(2);
const bankPath =
  (args.includes("--bank") ? args[args.indexOf("--bank") + 1] : null) ||
  process.env.MPC_CANDIDATE_BANK ||
  "/data/mpc-candidates.json";

// A proof line that is really the job description handed back. These read as duties anyone in
// the title performs, so they persuade nobody; the bank is where that gets caught, not the send.
const DUTY_LIST = [
  [/^own(?:ed|s)? (?:the )?month[- ]end close\.?$/i, "a duty every applicant claims"],
  [/^(?:own|manage|handle|perform|prepare|maintain|assist|support|responsible)\w*\b[^.]{0,28}$/i, "reads as a duty, not an accomplishment"],
  [/\band\b.*\band\b/i, "three or more things stacked; pick the two that pair"],
];

function load(p) {
  const raw = JSON.parse(readFileSync(p, "utf8"));
  return Array.isArray(raw) ? raw : raw.candidates || [];
}

let bank;
try {
  bank = load(bankPath);
} catch (e) {
  console.error(`cannot read bank at ${bankPath}: ${e.message}`);
  console.error("With no bank the writer still sends, at capability level, with no numbers and");
  console.error("no reason line. Add one to make the pitches convincing.");
  process.exit(1);
}

console.log(`bank: ${bankPath}`);
console.log(`records: ${bank.length}\n`);

let fatal = 0;
let soft = 0;
const families = new Map();

bank.forEach((c, i) => {
  const label = `#${i + 1} ${c && c.title ? c.title : "(no title)"}`;
  const problems = [];
  const warnings = [];

  if (!c || !c.title) problems.push("no title");
  const fam = c && (c.family || roleFamily(c.title || ""));
  if (!fam) problems.push("title resolves to no role family, so it can never match a req");

  const proof = (c && c.proof) || [];
  if (!Array.isArray(proof) || proof.length === 0) problems.push("no proof lines");
  else if (proof.length !== 2) warnings.push(`${proof.length} proof lines; the format wants exactly 2`);

  for (const line of proof) {
    const words = String(line).trim().split(/\s+/).filter(Boolean).length;
    if (words > 9) warnings.push(`proof too long (${words} words): "${line}"`);
    for (const [re, why] of DUTY_LIST) {
      if (re.test(String(line).trim())) { warnings.push(`${why}: "${line}"`); break; }
    }
  }

  if (!c || !c.reason) {
    warnings.push("no reason: the email will fall back to 'they're looking quietly', which is the weakest close in the format");
  }
  if (!c || (!c.metro && c.remoteOk !== true)) {
    warnings.push("no metro and remoteOk not set, so this record only matches reqs that carry a metro");
  }

  if (fam) families.set(fam, (families.get(fam) || 0) + 1);

  if (problems.length) {
    fatal++;
    console.log(`FAIL ${label}`);
    for (const p of problems) console.log(`       ${p}`);
  } else {
    console.log(`ok   ${label}  [${fam}${c.metro ? ", " + c.metro : c.remoteOk ? ", remote" : ""}]`);
  }
  for (const w of warnings) { soft++; console.log(`  warn ${w}`); }
});

console.log(`\ncoverage by family: ${[...families].map(([f, n]) => `${f}:${n}`).join("  ") || "(none)"}`);
console.log("A req whose family is not listed above falls back to capability-level copy: no");
console.log("numbers, no reason line. That still sends, it just persuades less.");
console.log(`\n${bank.length - fatal} usable, ${fatal} unusable, ${soft} warning(s)`);
process.exit(fatal ? 1 : 0);
