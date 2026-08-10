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
