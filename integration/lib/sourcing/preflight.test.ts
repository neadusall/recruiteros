/**
 * Pre-push preflight: regression suite.
 * Run: npx tsx lib/sourcing/preflight.test.ts   (exits non-zero on failure)
 *
 * Born from a real push (2026-07-31, "Hill Valley - FP&A"). The list was found,
 * enriched and pushed, every stage reported success, and the campaign still went
 * out able to text nobody: the template carried a merge token the SMS engine
 * could not resolve, so all 70 qualified contacts failed one at a time and the
 * campaign simply read 0 sent. Nothing between the search and the send had ever
 * asked "how many people will this actually reach?"
 *
 * These tests pin that question being asked BEFORE the push: a template that
 * resolves for nobody blocks, partial gaps warn and still send, an empty
 * first-sight push is always allowed, and every contact handed to the engine
 * comes back accounted for.
 */

import { preflightPush, reconcilePush } from "./preflight";
import type { SourcingRun } from "./types";
import type { OsTextContact } from "../ostextImport";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "  ✓ " : "  ✗ FAIL: ") + m); if (!c) fails++; };

function contact(o: Partial<OsTextContact> = {}): OsTextContact {
  return {
    firstName: "Alex",
    lastName: "Rivera",
    company: "Acme Health",
    jobTitle: "FP&A Analyst",
    phone: "+15555550123",
    email: "alex@acme.test",
    linkedinUrl: "https://linkedin.com/in/alex",
    location: "Woodmere, NY",
    customFields: {},
    ...o,
  };
}

function run(o: Partial<SourcingRun> = {}): SourcingRun {
  return {
    id: "srun_1",
    workspaceId: "ws_1",
    createdBy: { userId: "u1", name: "Noah Wilkowski", email: "noah@lumesp.com" },
    name: "Hill Valley - FP&A",
    motion: "recruiting",
    jd: "",
    icp: {} as SourcingRun["icp"],
    queries: [],
    candidates: [],
    warnings: [],
    enrichStartedAt: "2026-07-31T14:17:28.257Z",
    createdAt: "2026-07-31T14:17:19.267Z",
    updatedAt: "2026-07-31T14:17:19.267Z",
    ...o,
  } as SourcingRun;
}

const TEMPLATE = "Hi {first_name}, this is Noah reaching out about an FP&A opening.";
const people = (n: number) => Array.from({ length: n }, () => ({})) as SourcingRun["candidates"];

/* ---- the gate itself ---- */

const clean = preflightPush(run({ candidates: people(2) }), [contact(), contact({ phone: "+15555550124" })], TEMPLATE);
ok(clean.ok === true, "a clean push passes");
ok(clean.deliverable === 2, "both contacts count as deliverable");

// THE bug, caught upstream: a token that resolves for nobody.
const blocked = preflightPush(
  run({ candidates: people(2) }),
  [contact({ company: "" }), contact({ company: "", phone: "+15555550124" })],
  "Hi {first_name} at {company}",
);
ok(blocked.ok === false, "a template that resolves for NOBODY blocks the push");
ok(blocked.deliverable === 0, "nobody is counted deliverable");
ok(blocked.issues[0].code === "template_resolves_for_nobody", "the blocker names itself");
ok(blocked.issues[0].message.includes("no company on file"), "the blocker says which field is missing");

// The token that actually broke Hill Valley now resolves, so it must NOT block.
const camel = preflightPush(run({ candidates: people(1) }), [contact()], "Hi {FirstName}");
ok(camel.ok === true && camel.deliverable === 1,
  "{FirstName} passes: the engine resolves case/underscore variants");

const unknown = preflightPush(run({ candidates: people(1) }), [contact()], "Hi {salary_band}");
ok(unknown.ok === false, "a token that is not a field at all blocks");
ok(unknown.issues[0].message.includes("{salary_band}"), "the unknown token is named in the message");

const partial = preflightPush(
  run({ candidates: people(2) }),
  [contact(), contact({ company: "", phone: "+15555550124" })],
  "Hi {first_name} at {company}",
);
ok(partial.ok === true, "a partial gap warns rather than blocks");
ok(partial.deliverable === 1, "only the resolvable contact counts");
ok(partial.issues.find((i) => i.code === "template_partial")?.count === 1,
  "the warning counts exactly who would be left out");

/* ---- first-sight delivery must never be blocked ---- */

const empty = preflightPush(run({ candidates: people(500) }), [], TEMPLATE);
ok(empty.ok === true && empty.withPhone === 0,
  "an empty first-sight push is always allowed (the campaign must be visible)");

const inFlight = preflightPush(
  run({ candidates: people(500), laxisJob: { jobId: "j1" } as SourcingRun["laxisJob"] }),
  [contact()],
  TEMPLATE,
);
ok(inFlight.ok === true, "enrichment still running never blocks the push");
ok(inFlight.chain === "in-flight", "the chain state is recorded");
ok(inFlight.issues.find((i) => i.code === "enrichment_in_flight")?.count === 499,
  "the people still waiting on a number are stated, not left to be inferred");

/* ---- accounting for everyone else ---- */

const dupes = preflightPush(run({ candidates: people(2) }), [contact(), contact()], TEMPLATE);
ok(dupes.issues.find((i) => i.code === "duplicate_phones")?.count === 1,
  "duplicate numbers that will collapse are counted up front");

const unowned = preflightPush(run({ candidates: people(1), createdBy: undefined }), [contact()], TEMPLATE);
ok(unowned.issues.some((i) => i.code === "no_owner"),
  "a list with no recruiter warns that the campaign lands unassigned");

const custom = preflightPush(
  run({ candidates: people(1) }),
  [contact({ customFields: { phone_source: "koldinfo" } })],
  "from {PhoneSource}",
);
ok(custom.ok === true, "a real custom column resolves, loosely matched like the engine does");

/* ---- reconciliation: nothing disappears between us and the engine ---- */

const two = preflightPush(run({ candidates: people(2) }), [contact(), contact({ phone: "+15555550124" })], TEMPLATE);
ok(reconcilePush(two, { added: 1, knownNonMobile: 1, confirmedCell: 1 }) === null,
  "added + non-mobile accounting for everyone is silent");
const gap = reconcilePush(two, { added: 1, knownNonMobile: 0, confirmedCell: 0 });
ok(gap?.count === 1 && gap?.code === "unexplained_shortfall",
  "a contact that was sent but never landed is reported, not averaged away");

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall green");
process.exit(fails ? 1 : 0);
