/**
 * House-voice dash failsafe — regression suite.
 * Run: npx tsx lib/text/dashes.test.ts   (exits non-zero on failure)
 *
 * Guards the rule that NO dash (em/en/hyphen) reaches outbound copy, from any
 * source — the stripper itself AND the real generators (content library + MPC).
 */

import { stripDashes, hasDash } from "./dashes";
import { pullForProspect } from "../content/library";
import { renderMpcOutreach, type MpcCandidate } from "../bd/mpc";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "  ✓ " : "  ✗ FAIL: ") + m); if (!c) fails++; };
const eq = (got: string, exp: string, m: string) => ok(got === exp, m + (got === exp ? "" : `\n      got: ${got}\n      exp: ${exp}`));

// Stripper behavior.
eq(stripDashes("closed their round — usually the moment"), "closed their round, usually the moment", "em dash -> comma");
eq(stripDashes("a senior full-stack engineer"), "a senior full stack engineer", "intra-word hyphen -> space");
eq(stripDashes("state-of-the-art tooling"), "state of the art tooling", "chained hyphens -> spaces");
eq(stripDashes("- one\n- two"), "• one\n• two", "list bullets -> •");
eq(stripDashes("Book https://cal.com/ryan/talent-intro today"), "Book https://cal.com/ryan/talent-intro today", "URL hyphen preserved");
ok(!hasDash(stripDashes("hard-to-find, top-tier, co-founder — really")), "no dash survives a mixed string");
ok(stripDashes(stripDashes("a-b — c")) === stripDashes("a-b — c"), "idempotent");

// Real generators must be dash-free across every channel + signal.
for (const signal of ["funding_round", "job_repost", "layoff", "exec_hire"] as const) {
  for (const motion of ["bd", "recruiting"] as const) {
    const seq = pullForProspect({ title: "VP of Engineering", company: "Northwind Pay", industry: "fintech", firstName: "Dana", warmth: 90, motion, signal: signal as any, sender: "Ryan", calendarLink: "https://cal.com/ryan/intro" });
    const dirty = seq.touches.filter((t) => hasDash(t.body) || (t.subject ? hasDash(t.subject) : false));
    ok(dirty.length === 0, `content library dash-free (${motion}/${signal})`);
  }
}

const A: MpcCandidate = { id: "c1", function: "engineering", seniority: "senior", industry: "fintech", yearsExperience: 8, employers: ["Stripe", "Plaid"], wins: ["led the ledger migration that cut latency"], reasonForMove: "their platform charter was reorganized", desiredRole: "Series B+ platform leadership", availabilityDays: 30, consentToRepresent: true };
const o = renderMpcOutreach(A, { firstName: "Priya", company: "Northwind Pay", signalType: "hiring_velocity", sender: "Ryan", callbackNumber: "+1-555-0100" });
ok([o.email!.subject, o.email!.body, o.linkedin_connection!, o.linkedin_message!, o.voicemail!].every((s) => !hasDash(s)), "MPC outreach dash-free on every channel");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
