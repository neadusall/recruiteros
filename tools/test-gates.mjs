// Tests for the MPC quality gates. Plain node: node scripts/mpc/test-gates.mjs
import assert from "node:assert/strict";
import { assessProspect, foreignAffiliation, metroOf, checkRenderedEmail, roleFamily, roleFunctionGroup, dmFunction, buyerFit, buildCompanyKnowledge, isTalentBuyer } from "./gates.mjs";

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
  // 100-1,000 employee mandate (2026-08-20): every prospect now needs a CONFIRMED headcount
  // inside the band, so the fixture carries one.
  employeeCount: 400,
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
test("a title's own DEPARTMENT tail is not a different employer", () => {
  // The 2026-08-20 regression class: these were all being read as foreign companies, which
  // deleted the function owners and left the founders.
  for (const t of ["Director of Nursing", "VP of Manufacturing", "Head of Engineering",
    "Director of Marketing", "VP, Supply Chain", "Director of Revenue Operations",
    "Head of Clinical Services", "VP - Human Resources", "Director of Field Operations"]) {
    assert.equal(foreignAffiliation(t, "Cobalt Health"), null, t + " must not read as a foreign employer");
  }
  // ...while a genuinely different employer still trips it.
  assert.equal(foreignAffiliation("Director of Finance, Xeal", "Brex"), "Xeal");
  assert.equal(foreignAffiliation("Director of Finance @ Kapor Capital", "Carta"), "Kapor Capital");
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
test("render gate holds the wordy pre-MPC copy (length, run-on, lecture)", () => {
  // The two live 2026-08-20 sends that started this rewrite. Both must now be HELD.
  const northwood = checkRenderedEmail("community operations lead bench for northwood ravin",
    "We keep an active bench of Community Operations Leads, and a couple from our current list map cleanly to what you're hiring for. These are people who've run resident experience workflows and owned the financial operations side of community management in tandem, which is the real constraint in this role. Since it's rare to find someone comfortable bridging both the resident-facing work and the back-office finance discipline, we've banked a few strong fits as they come through the market. Worth a quick call to walk through who we have?");
  assert.equal(northwood.ok, false);
  const tonal = checkRenderedEmail("strategic finance leader for tonal, shortlist ready",
    "Every week this seat stays empty, your finance team is stretched thinner: someone's covering FP&A while another handles month-end close and a third patches together spreadsheets instead of owning automation. At your scale, that's a compounding cost. We just wrapped a search for a similar hardware/fitness company and have a few strong finance leaders who own the full stack, FP&A, accounting ops, and the systems work that actually scales a finance function. These aren't generic candidates; they've built the infrastructure you need. Worth a quick call to walk through who we have?");
  assert.equal(tonal.ok, false);
});
test("render gate holds a short email that hides a run-on sentence", () => {
  const r = checkRenderedEmail("controller, quietly looking",
    "I'm representing a Controller in Denver who has owned the monthly close, run the audit, rebuilt the chart of accounts, managed a team of six, and reported straight to the CFO for the last several years. Worth a look?");
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((x) => /sentence runs/.test(x)), r.problems.join("; "));
});
test("render gate passes the new MPC format", () => {
  const r = checkRenderedEmail("vp of sales, quietly looking",
    "I'm representing a VP of Sales in Denver.\n\nGrew a portfolio from $12M to $40M, built the team from 3 to 22 reps.\n\nThey're exploring their next move confidentially. Worth a look at their profile?");
  assert.equal(r.ok, true, r.problems.join("; "));
});
test("render gate passes a clean email", () => {
  const r = checkRenderedEmail("your assistant controller search, Vernon",
    "Hi Hali, saw Reformation's opening for an Assistant Controller in Vernon. worth a quick call? Best, Ryan");
  assert.equal(r.ok, true, r.problems.join("; "));
});

/* ------------------------------------------------------------------------------------------
 * OWNER-ONLY TARGETING + 100-1,000 HEADCOUNT BAND (owner mandate 2026-08-20)
 *
 * Pinned to STRICT here so the suite asserts the mandate itself, whatever the box env happens to
 * be set to. The transition-mode behaviour is asserted separately at the bottom.
 * ---------------------------------------------------------------------------------------- */
process.env.MPC_TARGETING_MODE = "strict";
process.env.MPC_SIZE_MODE = "confirmed";

test("owner-only: a CEO is NOT the buyer for a non-leadership req", () => {
  const p = base(); p.managerName = "Dave Girouard"; p.managerTitle = "Chief Executive Officer";
  p.likelyEmail = "dave.girouard@upstart.com";
  const r = assessProspect(p);
  assert.equal(r.eligible, false);
  assert.ok(r.failures.some(f => /whole-company exec/.test(f)), r.failures.join("; "));
});
test("owner-only: the function owner IS the buyer", () => {
  const p = base(); p.managerTitle = "VP of Finance";
  assert.equal(assessProspect(p).eligible, true, assessProspect(p).failures.join("; "));
});
test("owner-only: a company-level buyer row who does NOT own the function is rejected", () => {
  // The real problem case: the CHRO mined once per company, carrying whatever req happened to be
  // in hand. She does not own an accounting hire.
  const p = base(); p.managerName = "Nina Patel"; p.managerTitle = "Chief People Officer";
  p.likelyEmail = "nina.patel@upstart.com"; p.companyBuyerRow = true;
  const r = assessProspect(p);
  assert.equal(r.eligible, false);
  assert.ok(r.failures.some(f => /company-level buyer|owns People/.test(f)), r.failures.join("; "));
});
test("owner-only: a buyer row whose person DOES own the function is a valid target", () => {
  // Provenance does not outrank the fact: the CFO owns accounting hiring wherever the row came from.
  const p = base(); p.managerTitle = "Chief Financial Officer"; p.companyBuyerRow = true;
  const r = assessProspect(p);
  assert.equal(r.eligible, true, r.failures.join("; "));
});
test("owner-only: an ambiguous title cannot be confirmed as the owner", () => {
  const p = base(); p.managerName = "Pat Reilly"; p.managerTitle = "Vice President";
  p.likelyEmail = "pat.reilly@upstart.com";
  const r = assessProspect(p);
  assert.equal(r.eligible, false);
  assert.ok(r.failures.some(f => /names no function/.test(f)), r.failures.join("; "));
});
test("owner-only: the CEO IS the buyer for an executive-search req", () => {
  const p = base(); p.role = "VP of Finance"; p.managerName = "Dave Girouard";
  p.managerTitle = "Chief Executive Officer"; p.likelyEmail = "dave.girouard@upstart.com";
  const r = assessProspect(p);
  assert.equal(r.eligible, true, r.failures.join("; "));
});
test("headcount band: under 100, over 1,000, and unconfirmed are all held", () => {
  const small = base(); small.employeeCount = 40;
  assert.ok(assessProspect(small).failures.some(f => /outside the 100-1000/.test(f)));
  const big = base(); big.employeeCount = 3800;   // the Ping Identity class of company
  assert.ok(assessProspect(big).failures.some(f => /outside the 100-1000/.test(f)));
  const unknown = base(); delete unknown.employeeCount;
  assert.ok(assessProspect(unknown).failures.some(f => /unconfirmed/.test(f)), "unknown size must fail closed");
  const edgeLow = base(); edgeLow.employeeCount = 100;
  assert.equal(assessProspect(edgeLow).eligible, true);
  const edgeHigh = base(); edgeHigh.employeeCount = 1000;
  assert.equal(assessProspect(edgeHigh).eligible, true);
});

/* ---- classifier recall: the families and titles that used to fall through ---- */

test("roleFamily now recognises clinical, trades, construction, insurance and GTM ops", () => {
  assert.equal(roleFamily("Registered Nurse - ICU"), "Healthcare");
  assert.equal(roleFamily("Board Certified Behavior Analyst (BCBA)"), "Healthcare");
  assert.equal(roleFamily("Physical Therapist"), "Healthcare");
  assert.equal(roleFamily("CNC Machinist"), "Skilled Trades");
  assert.equal(roleFamily("Maintenance Technician"), "Skilled Trades");
  assert.equal(roleFamily("Construction Superintendent"), "Construction");
  assert.equal(roleFamily("Commercial Underwriter"), "Insurance");
  assert.equal(roleFamily("Revenue Operations Manager"), "Sales");
  // and the guards hold
  assert.equal(roleFamily("Financial Counselor"), "Finance", "must not read as clinical");
  assert.equal(roleFamily("Staff Accountant"), "Accounting");
  assert.equal(roleFamily("VP of Finance"), "Finance", "phrasing the patterns missed now resolves");
  assert.equal(roleFamily("Head of Manufacturing"), "Operations");
  assert.equal(roleFamily("Customer Success Manager"), "Customer Success");
  assert.equal(roleFamily("Data Analyst"), "Data");
  assert.equal(roleFamily("Facilities Manager"), "Operations");
  assert.equal(roleFamily("Senior Project Manager"), "Operations");
  // a data req is owned by the eng/data chain, so a CTO or a Head of Data both qualify
  assert.equal(roleFunctionGroup(roleFamily("Data Analyst")), "Engineering");
  assert.equal(dmFunction("Head of Data"), "Engineering");
  assert.equal(dmFunction("VP of Customer Success"), "Customer Success");
});
test("function groups route the new families to the leader who owns them", () => {
  assert.equal(roleFunctionGroup(roleFamily("Registered Nurse - ICU")), "Clinical");
  assert.equal(roleFunctionGroup(roleFamily("CNC Machinist")), "Operations");
  assert.equal(roleFunctionGroup(roleFamily("Construction Superintendent")), "Operations");
  assert.equal(roleFunctionGroup(roleFamily("Commercial Underwriter")), "Finance");
});
test("dmFunction recall: real owners no longer read as ambiguous", () => {
  assert.equal(dmFunction("Director of Accounting"), "Finance");
  assert.equal(dmFunction("Tax Partner"), "Finance");
  assert.equal(dmFunction("VP of Manufacturing"), "Operations");
  assert.equal(dmFunction("Director of Nursing"), "Clinical");
  assert.equal(dmFunction("Chief Nursing Officer"), "Clinical");
  assert.equal(dmFunction("VP of Business Development"), "Sales");
  assert.equal(dmFunction("Chief Commercial Officer"), "Sales");
  // guards: these must NOT be miscast
  assert.equal(dmFunction("Medical Device Sales Director"), "Sales");
  assert.equal(dmFunction("Chief Executive Officer"), "universal");
});
test("a nurse req routes to the nursing leader, not the CEO", () => {
  const p = base(); p.company = "Cobalt Health"; p.domain = "cobalthealth.com";
  p.role = "Registered Nurse - ICU"; p.managerName = "Dana Reed"; p.managerTitle = "Director of Nursing";
  p.likelyEmail = "dana.reed@cobalthealth.com";
  assert.equal(assessProspect(p).eligible, true, assessProspect(p).failures.join("; "));
  const q = { ...p, managerName: "Sam Okafor", managerTitle: "Chief Executive Officer", likelyEmail: "sam.okafor@cobalthealth.com" };
  assert.equal(assessProspect(q).eligible, false);
});
test("a bare 'CTO' is a valid buyer for an engineering req", () => {
  // Regression: the acronym class was c[efoimrph]o, with no "t", so every CTO row was thrown out
  // as "not a senior buyer" — the one person who most owns an engineering hire.
  const p = base(); p.company = "Socket"; p.domain = "socket.dev"; p.role = "Senior Backend Engineer";
  p.managerName = "Alex Kim"; p.managerTitle = "CTO"; p.likelyEmail = "alex.kim@socket.dev";
  const r = assessProspect(p);
  assert.equal(r.eligible, true, r.failures.join("; "));
  // ...and the clinical/plant-floor owners are buyers too
  const n = base(); n.company = "Cobalt Health"; n.domain = "cobalthealth.com"; n.role = "Registered Nurse - ICU";
  n.managerName = "Dana Reed"; n.managerTitle = "Nurse Manager"; n.likelyEmail = "dana.reed@cobalthealth.com";
  assert.equal(assessProspect(n).eligible, true, assessProspect(n).failures.join("; "));
});
test("buyerFit agrees with assessProspect and names the recoverable holds", () => {
  const rows = [
    { company: "Upstart", role: "Staff Accountant", managerTitle: "Chief Executive Officer" },
    { company: "Upstart", role: "Financial Analyst", managerTitle: "VP of Finance" },
  ];
  const know = buildCompanyKnowledge(rows);
  const ceo = buyerFit({ company: "Upstart", role: "Staff Accountant", managerTitle: "Chief Executive Officer" }, know);
  assert.equal(ceo.ok, false);
  assert.ok(/already names a Finance leader/.test(ceo.why), ceo.why);
  const owner = buyerFit({ company: "Upstart", role: "Staff Accountant", managerTitle: "VP of Finance" }, know);
  assert.equal(owner.ok, true);
  assert.equal(owner.rank, 0);
  // no leader known anywhere -> a different, honest reason
  const cold = buyerFit({ company: "Nowhere Co", role: "Staff Accountant", managerTitle: "Founder" }, buildCompanyKnowledge([]));
  assert.equal(cold.ok, false);
  assert.ok(/hold until the Finance owner/.test(cold.why), cold.why);
});

/* ------------------------------------------------------------------------------------------
 * TRANSITION MODE (the default while the pipeline re-curates under the new targeting)
 * ---------------------------------------------------------------------------------------- */
process.env.MPC_TARGETING_MODE = "transition";
process.env.MPC_SIZE_MODE = "known-bad-only";

test("transition: a CEO may send when nobody better is known", () => {
  const p = base(); p.managerName = "Dave Girouard"; p.managerTitle = "Chief Executive Officer";
  p.likelyEmail = "dave.girouard@upstart.com";
  assert.equal(assessProspect(p).eligible, true, assessProspect(p).failures.join("; "));
});
test("transition: a DIFFERENT-function exec is STILL rejected", () => {
  // The one thing that was never defensible stays rejected in both modes. The example used to
  // be a Chief People Officer; that became a VALID buyer on 2026-08-20 (owner call: we sell
  // recruiting, so the talent leader buys hiring for every function), so this now uses a
  // marketing exec, who genuinely does not own an accounting hire.
  const p = base(); p.managerName = "Nina Patel"; p.managerTitle = "Chief Marketing Officer";
  p.likelyEmail = "nina.patel@upstart.com";
  const r = assessProspect(p);
  assert.equal(r.eligible, false);
  assert.ok(r.failures.some(f => /owns Marketing, not the Finance/.test(f)), r.failures.join("; "));
});
test("talent leader: a CHRO IS a buyer for another function's req", () => {
  // Owner call 2026-08-20. Hiring is the People/HR function's own remit whatever the req is.
  const p = base(); p.managerName = "Nina Patel"; p.managerTitle = "Chief People Officer";
  p.likelyEmail = "nina.patel@upstart.com";
  const r = assessProspect(p);
  assert.equal(r.eligible, true, r.failures.join("; "));
});
test("talent leader: in-house practitioners never get the talent-buyer carve-out", () => {
  // They do not sign search agreements, and in-house talent staff are measured on REDUCING
  // agency spend. "Partner" alone must not qualify them: VALID_DM_TITLE matches the bare word,
  // which is how "Talent Acquisition Partner" first slipped through. Asserted on isTalentBuyer
  // itself rather than eligibility, because transition mode separately lets an ambiguous-function
  // senior through when nobody better is known, and that rule is not what this carve-out governs.
  for (const title of ["Talent Acquisition Partner", "HR Business Partner", "People Operations Specialist",
    "Talent Acquisition Coordinator", "Senior Technical Recruiter"]) {
    assert.equal(isTalentBuyer(title), false, `${title} must not count as a talent buyer`);
  }
  for (const title of ["Chief People Officer", "CHRO", "VP of Human Resources", "Head of Talent"]) {
    assert.equal(isTalentBuyer(title), true, `${title} should count as a talent buyer`);
  }
});
test("talent leader: strict mode still holds a company-level buyer row", () => {
  // Strict exists to demand a buyer resolved against THIS req, and the per-company CHRO row
  // never was. The carve-out must not become a back door for 45.7% of the store.
  const prev = process.env.MPC_TARGETING_MODE;
  process.env.MPC_TARGETING_MODE = "strict";
  try {
    const p = base(); p.managerName = "Nina Patel"; p.managerTitle = "Chief People Officer";
    p.likelyEmail = "nina.patel@upstart.com"; p.companyBuyerRow = true;
    assert.equal(assessProspect(p).eligible, false);
    const resolved = base(); resolved.managerName = "Nina Patel"; resolved.managerTitle = "Chief People Officer";
    resolved.likelyEmail = "nina.patel@upstart.com";
    assert.equal(assessProspect(resolved).eligible, true, "a req-resolved talent leader still sends in strict mode");
  } finally {
    if (prev === undefined) delete process.env.MPC_TARGETING_MODE; else process.env.MPC_TARGETING_MODE = prev;
  }
});
test("transition: unconfirmed size sends with a warning, confirmed-out-of-band still does not", () => {
  const unknown = base(); delete unknown.employeeCount;
  const r = assessProspect(unknown);
  assert.equal(r.eligible, true, r.failures.join("; "));
  assert.ok(r.warnings.some(w => /size unconfirmed/.test(w)), r.warnings.join("; "));
  // Positively confirmed outside the band is data telling us NOT to send: rejected in both modes.
  const big = base(); big.employeeCount = 3800;
  assert.equal(assessProspect(big).eligible, false);
  const small = base(); small.employeeCount = 40;
  assert.equal(assessProspect(small).eligible, false);
});
test("transition: the role owner is still preferred (buyerFit rank 0 vs held)", () => {
  const know = buildCompanyKnowledge([{ company: "Upstart", role: "Financial Analyst", managerTitle: "VP of Finance" }]);
  assert.equal(buyerFit({ company: "Upstart", role: "Staff Accountant", managerTitle: "VP of Finance" }, know).rank, 0);
  assert.equal(buyerFit({ company: "Upstart", role: "Staff Accountant", managerTitle: "Chief Executive Officer" }, know).ok, false);
});


test("talent leader: must be IN-HOUSE, never an agency or another employer", () => {
  // The carve-out widened who counts as a buyer, so it must not widen WHICH COMPANY they sit
  // at. A Head of Talent at a staffing firm is a competitor, and one whose title names a
  // different employer was never resolved against this req. Both are rejected by gates that
  // run independently of the carve-out (staffingFirmSignal, foreignAffiliation); this pins
  // that they still fire for talent titles specifically.
  const base = () => ({
    company: "Upstart", role: "Senior Software Engineer", industry: "Financial Services",
    managerName: "Nina Patel", managerTitle: "Chief People Officer",
    likelyEmail: "nina.patel@upstart.com", emailValidated: true,
    jobUrl: "https://upstart.com/careers/1", employeeCount: 400,
    curatedAt: new Date().toISOString(),
  });
  assert.equal(assessProspect(base()).eligible, true, "the in-house talent leader is the whole point");

  for (const [company, email] of [["Vaco Staffing", "n@vaco.com"], ["Robert Half Recruiting", "n@roberthalf.com"], ["Cielo Talent Solutions", "n@cielotalent.com"]]) {
    const agency = { ...base(), company, likelyEmail: email, managerTitle: "Head of Talent" };
    const r = assessProspect(agency);
    assert.equal(r.eligible, false, `${company} is a competitor, never a client`);
    assert.ok(r.failures.some((f) => /staffing\/recruiting firm/.test(f)), r.failures.join("; "));
  }

  const elsewhere = { ...base(), managerTitle: "Head of Talent at LGC Group" };
  const r = assessProspect(elsewhere);
  assert.equal(r.eligible, false, "a talent leader at another employer is not this req's buyer");
  assert.ok(r.failures.some((f) => /different company/.test(f)), r.failures.join("; "));
});

console.log("\n" + passed + " passed");
