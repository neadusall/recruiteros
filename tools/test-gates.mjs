// Tests for the MPC quality gates. Plain node: node scripts/mpc/test-gates.mjs
import assert from "node:assert/strict";
import { assessProspect, foreignAffiliation, metroOf, checkRenderedEmail } from "./gates.mjs";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.error("FAIL " + name); console.error(e.message); process.exitCode = 1; }
}

const base = () => ({
  id: "x", company: "Upstart", domain: "upstart.com", signalType: "hiring_velocity",
  signalReason: "Posted 82 open roles", role: "Bank Accounting and Regulatory Reporting Senior Associate",
  jobLocation: "United States | Remote", score: 90,
  managerName: "Andrea Blankmeyer", managerTitle: "Chief Financial Officer",
  likelyEmail: "andrea.blankmeyer@upstart.com", status: "contactable", curatedAt: "2026-08-10",
  emailValidated: true,
});

test("clean accounting hire + real CFO + validated email is eligible", () => {
  const r = assessProspect(base());
  assert.equal(r.eligible, true, r.failures.join("; "));
});
test("blocks a non-accounting hire (Data Science Intern)", () => {
  const p = base(); p.role = "Data Science Intern"; p.company = "Faire"; p.domain = "faire.com";
  p.managerName = "Carson Lam"; p.managerTitle = "Director of Finance & Strategy"; p.likelyEmail = "carson.lam@faire.com";
  assert.equal(assessProspect(p).eligible, false);
});
test("blocks a decision-maker at a DIFFERENT company (FinTech Futures)", () => {
  const p = base(); p.company = "Mercury"; p.domain = "mercury.com"; p.role = "Chief Audit Officer";
  p.managerName = "Jason Whiting"; p.managerTitle = "CFO - FinTech Futures"; p.likelyEmail = "jason.whiting@mercury.com";
  const r = assessProspect(p);
  assert.equal(r.eligible, false);
  assert.ok(r.failures.some(f => /different company/.test(f)), r.failures.join("; "));
});
test("blocks 'Director of Finance, Xeal' against Brex", () => {
  const p = base(); p.company = "Brex"; p.domain = "brex.com"; p.role = "Accounting Manager";
  p.managerName = "Justin Wade"; p.managerTitle = "Director of Finance, Xeal"; p.likelyEmail = "justin.wade@brex.com";
  assert.equal(assessProspect(p).eligible, false);
});
test("blocks 'Director of Finance @ Kapor Capital' against Carta (catch-all too)", () => {
  const p = base(); p.company = "Carta"; p.domain = "carta.com"; p.role = "Associate Fund Controller";
  p.managerName = "Landry Nicks"; p.managerTitle = "Director of Finance @ Kapor Capital"; p.likelyEmail = "landry.nicks@carta.com";
  p.emailCatchAll = true; p.emailValidated = false;
  assert.equal(assessProspect(p).eligible, false);
});
test("same company in the title is fine", () => {
  assert.equal(foreignAffiliation("Director of Finance at Faire", "Faire"), null);
  assert.equal(foreignAffiliation("CFO - FinTech Futures", "Mercury"), "FinTech Futures");
});
test("blocks catch-all / unvalidated email", () => {
  const p = base(); p.emailValidated = false; p.emailCatchAll = true;
  assert.equal(assessProspect(p).eligible, false);
});
test("blocks email domain mismatch", () => {
  const p = base(); p.likelyEmail = "andrea@somewhereelse.com";
  assert.equal(assessProspect(p).eligible, false);
});
test("blocks a recruiter/coordinator posing as the buyer", () => {
  const p = base(); p.managerName = "Talent Coordinator"; p.managerTitle = "Vice President";
  assert.equal(assessProspect(p).eligible, false);
});
test("blocks a scraper-artifact name (Toggle Description)", () => {
  const p = base(); p.company = "OppFi"; p.domain = "oppfi.com";
  p.managerName = "Toggle Description"; p.managerTitle = "Chief Financial Officer"; p.likelyEmail = "toggle.description@oppfi.com";
  assert.equal(assessProspect(p).eligible, false);
});
test("blocks a role/shared inbox + junk local-part email", () => {
  const p = base(); p.company = "Digital Direction"; p.domain = "digitaldirection.ca";
  p.managerName = "Measurable Results"; p.managerTitle = "Owner"; p.likelyEmail = "measurable.results@digitaldirection.ca";
  assert.equal(assessProspect(p).eligible, false);
  const q = base(); q.likelyEmail = "info@upstart.com";
  assert.ok(assessProspect(q).failures.some(f => /role\/shared inbox/.test(f)));
});
test("blocks web/marketing scraper artifacts (Trending Topics / Founder Managing)", () => {
  const a = base(); a.company = "CBH"; a.domain = "cbh.com";
  a.managerName = "Trending Topics"; a.managerTitle = "Chief Financial Officer"; a.likelyEmail = "trending.topics@cbh.com";
  assert.equal(assessProspect(a).eligible, false);
  const b = base(); b.company = "Socket"; b.domain = "socket.dev";
  b.managerName = "Founder Managing"; b.managerTitle = "Founder"; b.likelyEmail = "foundermanaging.ventures@socket.dev";
  assert.equal(assessProspect(b).eligible, false);
});
test("blocks mangled-encoding remnants in name or local-part (the 8/18-19 bounce class)", () => {
  const a = base(); a.managerName = "President8217s Office"; a.managerTitle = "Chief Executive Officer";
  a.likelyEmail = "president8217s.office@upstart.com";
  assert.equal(assessProspect(a).eligible, false);
  const b = base(); b.managerName = "Robert Ox27donovan"; b.managerTitle = "Chief Financial Officer";
  b.likelyEmail = "robert.ox27donovan@upstart.com";
  assert.equal(assessProspect(b).eligible, false);
  const c = base(); c.likelyEmail = "marc.jessxe9@upstart.com"; // é mangled to xe9
  assert.ok(assessProspect(c).failures.some(f => /mangled-encoding/.test(f)));
});
test("blocks UI-string locals that bounced 8/18-19 (thank.you / see.bio / select.page / what.do)", () => {
  for (const local of ["thank.you", "see.bio", "select.page", "what.do", "by.role", "executive.committee"]) {
    const p = base(); p.likelyEmail = local + "@upstart.com";
    assert.ok(assessProspect(p).failures.some(f => /parsed artifact|role\/shared/.test(f)), local + " should be blocked");
  }
  // Real names stay eligible: the tokens must not overreach.
  for (const [name, local] of [["Fabio Lanzoni", "fabio.lanzoni"], ["Linh Do", "linh.do"], ["Digby Jones", "digby.jones"], ["Amy See", "amy.see"]]) {
    const p = base(); p.managerName = name; p.likelyEmail = local + "@upstart.com";
    const r = assessProspect(p);
    assert.equal(r.eligible, true, name + ": " + r.failures.join("; "));
  }
});
test("metroOf pulls a real metro, rejects remote", () => {
  assert.equal(metroOf({ jobLocation: "Vernon, CA" }), "Vernon, CA");
  assert.equal(metroOf({ jobLocation: "United States | Remote" }), null);
});
test("render gate catches token/empty/hole/em-dash/placeholder", () => {
  assert.equal(checkRenderedEmail("hi", "maps to your {{Open_Role}} seat").ok, false);
  assert.equal(checkRenderedEmail("", "body").ok, false);
  assert.equal(checkRenderedEmail("subj", "maps to your  seat").ok, false);
  assert.equal(checkRenderedEmail("subj", "worth a chat — really?").ok, false);
  assert.equal(checkRenderedEmail("subj", "leftover [role] here").ok, false);
});
test("render gate passes a clean email", () => {
  const r = checkRenderedEmail("your assistant controller search, Vernon",
    "Hi Hali, saw Reformation's opening for an Assistant Controller in Vernon. worth a quick call? Best, Ryan");
  assert.equal(r.ok, true, r.problems.join("; "));
});

console.log("\n" + passed + " passed");
