/**
 * Regression suite for the phone-yield fixes (2026-07-16):
 *   1. Laxis merge reads EVERY phone column, cell-first, per row.
 *   2. KoldInfo result parse falls back across phone columns per row
 *      (person_sanitized_phone can be blank while person_phone is filled).
 *   3. LandlineDB matcher: conservative accept rules + state extraction.
 *
 * Run from integration/:  npx tsx scripts/test-sourcing-phones.mts
 */

import { mergeEnrichedCsv } from "../lib/sourcing/laxis";
import { mergeSourcingKoldInfoCsv, sourcingKoldId } from "../lib/sourcing/koldinfo";
import { stateFromLocation } from "../lib/sourcing/landlinePhones";
import type { CandidateRow } from "../lib/sourcing/types";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log("  ok  " + name); }
  else { failed++; console.error("FAIL  " + name); }
}

const cand = (over: Partial<CandidateRow>): CandidateRow => ({
  fullName: "Pat Example", company: "Acme Logistics", title: "VP",
  fitScore: 50, sources: [], ...over,
} as unknown as CandidateRow);

/* 1 ── Laxis merge: multiple phone columns ---------------------------------- */
{
  // Row A: number only in Cellphone. Row B: number only in Work Phone.
  // Old code picked ONE column ("Work Phone" via the prefer regex) and lost row A.
  const csv = [
    "Full Name,Company Name,Email Address,Cellphone,Work Phone,LinkedIn URL",
    'Pat Example,Acme Logistics,pat@acme.com,+12015551000,null,linkedin.com/in/pat',
    'Sam Person,Beta Corp,sam@beta.com,null,+13125552000,linkedin.com/in/sam',
    'Jo Status,Gamma Inc,jo@gamma.com,null,null,linkedin.com/in/jo',
  ].join("\r\n");
  const rows = [
    cand({ fullName: "Pat Example", company: "Acme Logistics", linkedinUrl: "https://www.linkedin.com/in/pat" }),
    cand({ fullName: "Sam Person", company: "Beta Corp", linkedinUrl: "https://www.linkedin.com/in/sam" }),
    cand({ fullName: "Jo Status", company: "Gamma Inc", linkedinUrl: "https://www.linkedin.com/in/jo" }),
  ];
  const res = mergeEnrichedCsv(rows, csv);
  check("laxis: cell-only row keeps its number", rows[0].phone === "+12015551000");
  check("laxis: work-only row still gains its number", rows[1].phone === "+13125552000");
  check("laxis: all-null row gains nothing", !rows[2].phone);
  check("laxis: phones counted = 2", res.phones === 2);
}
{
  // Cell wins over work when BOTH are present on the same row.
  const csv = [
    "Full Name,Work Phone,Cellphone,LinkedIn URL",
    "Pat Example,+19995550000,+12015551000,linkedin.com/in/pat",
  ].join("\r\n");
  const rows = [cand({ linkedinUrl: "linkedin.com/in/pat" })];
  mergeEnrichedCsv(rows, csv);
  check("laxis: cell preferred over work line", rows[0].phone === "+12015551000");
}
{
  // A "Phone Status"-style column must never be mistaken for a number.
  const csv = [
    "Full Name,Phone Status,Cellphone,LinkedIn URL",
    "Pat Example,valid,+12015551000,linkedin.com/in/pat",
  ].join("\r\n");
  const rows = [cand({ linkedinUrl: "linkedin.com/in/pat" })];
  mergeEnrichedCsv(rows, csv);
  check("laxis: status column ignored, real number kept", rows[0].phone === "+12015551000");
}

/* 2 ── KoldInfo parse: per-row phone-column fallback ------------------------ */
{
  const rows = [
    cand({ fullName: "Pat Example", company: "Acme Logistics" }),
    cand({ fullName: "Sam Person", company: "Beta Corp" }),
  ];
  // Row 1: sanitized blank, raw filled (E.164 conversion failed vendor-side).
  // Row 2: sanitized filled. Old code read ONLY the sanitized column → row 1 lost.
  const csv = [
    "ros_id,person_email,person_sanitized_phone,person_phone,person_email_status_cd",
    `${sourcingKoldId(rows[0])},pat@acme.com,,201-555-1000,valid`,
    `${sourcingKoldId(rows[1])},sam@beta.com,+13125552000,3125552000,valid`,
  ].join("\n");
  const res = mergeSourcingKoldInfoCsv(rows, csv);
  check("koldinfo: raw person_phone rescues a blank sanitized cell", rows[0].phone === "201-555-1000");
  check("koldinfo: sanitized E.164 still preferred when present", rows[1].phone === "+13125552000");
  check("koldinfo: phones counted = 2", res.phones === 2);
  check("koldinfo: emails still merge", rows[0].email === "pat@acme.com" && rows[1].email === "sam@beta.com");
}

/* 3 ── LandlineDB state extraction ------------------------------------------ */
{
  check("state: City, ST form", stateFromLocation("Fair Lawn, NJ") === "NJ");
  check("state: full state name", stateFromLocation("New Jersey") === "NJ");
  check("state: name inside a metro label", stateFromLocation("Greater Chicago, Illinois Area") === "IL");
  check("state: unknown metro label → empty", stateFromLocation("Greater Chicago Area") === "");
  check("state: empty input → empty", stateFromLocation("") === "");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
