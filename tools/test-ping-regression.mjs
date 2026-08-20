// Regression: the 2026-08-12 Ping Identity leak (Founder & CEO got the Lead Accountant pitch,
// body claimed "local to your market" on a record the batch treated as remote).
import { assessProspect, checkRenderedEmail, dmFunction, roleFamily, roleFunctionGroup, buildCompanyKnowledge, buyerFit, isSeniorHire, staffingFirmSignal, rescueDecisionMaker, extractPersonFromTitle } from "./gates.mjs";

// Pinned to STRICT: this suite asserts the owner-only mandate itself, so it must not shift when the
// box is running in transition mode. Transition behaviour is covered in test-gates.mjs.
process.env.MPC_TARGETING_MODE = "strict";
process.env.MPC_SIZE_MODE = "confirmed";

let passed = 0, failed = 0;
function t(name, cond, detail) {
  if (cond) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? " :: " + detail : ""}`); }
}

const base = {
  company: "Pingidentity", domain: "pingidentity.com", role: "Lead Accountant",
  likelyEmail: "andredurand@pingidentity.com", emailValidated: true,
  jobLocation: "Denver, Colorado, United States",
};

// 1) CEO at a known-large company for an IC accounting role -> HELD, with the reason.
const bigCeo = assessProspect({ ...base, managerName: "Andre Durand", managerTitle: "Founder & CEO, Ping Identity", employeeCount: 3800 });
t("CEO at 3800-person company is held for IC role", !bigCeo.eligible && bigCeo.failures.some((f) => /whole-company exec/.test(f)), JSON.stringify(bigCeo.failures));

// 2) Same CEO, size unknown -> HELD twice over under the 2026-08-20 mandate: a whole-company exec
//    is never the buyer for an IC req, and an unconfirmed headcount fails closed.
const unkCeo = assessProspect({ ...base, managerName: "Andre Durand", managerTitle: "Founder & CEO, Ping Identity" });
t("CEO with unknown size is held (owner-only + confirmed-size)",
  !unkCeo.eligible && unkCeo.failures.some((f) => /whole-company exec/.test(f)) && unkCeo.failures.some((f) => /unconfirmed/.test(f)),
  JSON.stringify(unkCeo.failures));

// 3) CEO at a genuinely small shop -> held: 40 employees is below the 100-1,000 band, and the CEO
//    is not the owner of an accounting req regardless.
const smallCeo = assessProspect({ ...base, company: "Riverbend Books", domain: "riverbendbooks.com", likelyEmail: "amy@riverbendbooks.com", managerName: "Amy Chen", managerTitle: "Owner & CEO", employeeCount: 40 });
t("CEO at 40-person company is now held (below the 100-1,000 band)",
  !smallCeo.eligible && smallCeo.failures.some((f) => /outside the 100-1000/.test(f)), JSON.stringify(smallCeo.failures));

// 4) CEO for an EXECUTIVE role: still the right BUYER, but 3,800 heads is outside the band, so the
//    row is held on SIZE only. The buyer half of the gate must stay silent here.
const execRole = assessProspect({ ...base, role: "President, Managing Director", managerName: "Andre Durand", managerTitle: "Founder & CEO, Ping Identity", employeeCount: 3800 });
t("CEO on an executive req is held on SIZE only, never on the buyer",
  !execRole.eligible && execRole.failures.some((f) => /outside the 100-1000/.test(f)) && !execRole.failures.some((f) => /decision-maker/.test(f)),
  JSON.stringify(execRole.failures));

// 4b) ...and the same executive req INSIDE the band passes cleanly.
const execRoleInBand = assessProspect({ ...base, role: "President, Managing Director", managerName: "Andre Durand", managerTitle: "Founder & CEO, Ping Identity", employeeCount: 600 });
t("CEO on an executive req inside the band passes", execRoleInBand.eligible, JSON.stringify(execRoleInBand.failures));

// 5) Function leader at a big company -> held on SIZE only (the CFO IS the right buyer).
const cfoBig = assessProspect({ ...base, likelyEmail: "jane.doe@pingidentity.com", managerName: "Jane Doe", managerTitle: "Chief Financial Officer", employeeCount: 3800 });
t("CFO at 3800-person company is held on size, not on the buyer",
  !cfoBig.eligible && cfoBig.failures.some((f) => /outside the 100-1000/.test(f)) && !cfoBig.failures.some((f) => /decision-maker/.test(f)),
  JSON.stringify(cfoBig.failures));

// 5b) The same CFO at an in-band company is exactly who we want to mail.
const cfoInBand = assessProspect({ ...base, likelyEmail: "jane.doe@pingidentity.com", managerName: "Jane Doe", managerTitle: "Chief Financial Officer", employeeCount: 600 });
t("CFO at a 600-person company passes (the target case)", cfoInBand.eligible, JSON.stringify(cfoInBand.failures));

// 6) Render gate: remote role claiming local candidates -> rejected.
const remoteLocal = checkRenderedEmail("lead accountant bench", "Just wrapped a search and have strong people local to your market ready to move.", { remote: true });
t("remote + 'local to your market' rejected", !remoteLocal.ok && remoteLocal.problems.some((p) => /local candidates on a remote/.test(p)), JSON.stringify(remoteLocal.problems));

// 7) Render gate: metro'd role naming the metro -> clean.
const metroNamed = checkRenderedEmail("lead accountant in denver", "Two strong Lead Accountant candidates local to Denver from a recent identity-software search. Worth a quick call?", { remote: false });
t("metro'd email naming the metro passes", metroNamed.ok, JSON.stringify(metroNamed.problems));

// 8) Render gate stays backward-compatible with the 2-arg call.
const twoArg = checkRenderedEmail("subject line", "A clean normal body with nothing wrong in it at all. Worth a quick chat?");
t("2-arg checkRenderedEmail still works", twoArg.ok, JSON.stringify(twoArg.problems));

// 9) Buyer preference ranking mirrors batch.mjs dmRank: CFO > VP Chief of Staff > CEO for accounting.
const rank = (title, role = "Lead Accountant") => {
  const fn = dmFunction(title);
  if (fn && fn !== "universal" && fn === roleFunctionGroup(roleFamily(role))) return 0;
  if (fn === null) return 1;
  if (fn === "universal") return 2;
  return 3;
};
t("CFO outranks VP Chief of Staff outranks CEO", rank("Chief Financial Officer") < rank("VP, Chief Of Staff at Ping Identity") && rank("VP, Chief Of Staff at Ping Identity") < rank("Founder & CEO, Ping Identity"), `${rank("Chief Financial Officer")} / ${rank("VP, Chief Of Staff at Ping Identity")} / ${rank("Founder & CEO, Ping Identity")}`);

// ---- Title-to-title buyer correlation (the full Ping replay) ----

// The actual pool shape on Aug 12: CEO row + Chief-of-Staff row for the Lead Accountant req,
// plus an UNNAMED "Director of Finance" row for another Ping req proving a finance org exists.
const pingPool = [
  { company: "Pingidentity", role: "Lead Accountant", managerName: "Andre Durand", managerTitle: "Founder & CEO, Ping Identity" },
  { company: "Pingidentity", role: "Lead Accountant", managerName: "Hallie Feenick Hill", managerTitle: "VP, Chief Of Staff at Ping Identity" },
  { company: "Ping Identity", role: "Senior Accountant - Process Improvement & Audit Readiness", managerTitle: "Director of Finance" },
];
const know = buildCompanyKnowledge(pingPool);

// 10) Company keys merge across "Pingidentity" / "Ping Identity" spellings.
t("company knowledge merges spelling variants", know.size === 1 && know.get("pingidentity").fnLeaders.has("Finance"), JSON.stringify([...know.keys()]));

// 11) The CEO row is HELD because the pool proves a finance leader exists.
const ceoFit = buyerFit(pingPool[0], know);
t("Ping CEO row held (finance leader known to exist)", !ceoFit.ok && /Finance leader/.test(ceoFit.why), JSON.stringify(ceoFit));

// 12) The Chief-of-Staff row is HELD for the same reason (ambiguous title, better buyer exists).
const cosFit = buyerFit(pingPool[1], know);
t("Ping Chief-of-Staff row held too", !cosFit.ok && /Finance leader|names no function/.test(cosFit.why), JSON.stringify(cosFit));

// 13) Once the Director of Finance is NAMED, their row is rank-0 (the right person wins).
const dofFit = buyerFit({ company: "Ping Identity", role: "Lead Accountant", managerName: "Pat Doe", managerTitle: "Director of Finance" }, know);
t("named Director of Finance is rank-0", dofFit.ok && dofFit.rank === 0, JSON.stringify(dofFit));

// 14) OWNER-ONLY (2026-08-20): a CEO is no longer a fallback buyer even at a tiny shop where
//     nobody better is known. The row is held and the reason says what to go find.
const smallKnow = buildCompanyKnowledge([{ company: "Riverbend Books", role: "Staff Accountant", managerName: "Amy Chen", managerTitle: "Owner & CEO" }]);
const smallFit = buyerFit({ company: "Riverbend Books", role: "Staff Accountant", managerTitle: "Owner & CEO" }, smallKnow);
t("small-shop CEO is held: find the Finance owner instead",
  !smallFit.ok && /hold until the Finance owner/.test(smallFit.why), JSON.stringify(smallFit));

// 15) A CEO row is held whether or not the company looks big; when the right owner IS already
//     named in the pool the reason says so, because that is recoverable work.
const bigPool = Array.from({ length: 9 }, (_, i) => ({ company: "MegaCorp", role: `Role ${i}`, managerTitle: "Hiring Manager" }));
const bigFit = buyerFit({ company: "MegaCorp", role: "Staff Accountant", managerTitle: "Founder & CEO", employeeCount: undefined }, buildCompanyKnowledge(bigPool));
t("CEO row on an IC req is held", !bigFit.ok, JSON.stringify(bigFit));
const knownOwnerFit = buyerFit({ company: "MegaCorp", role: "Staff Accountant", managerTitle: "Founder & CEO" },
  buildCompanyKnowledge([{ company: "MegaCorp", role: "Financial Analyst", managerTitle: "VP of Finance" }]));
t("CEO row names the owner we already have", !knownOwnerFit.ok && /already names a Finance leader/.test(knownOwnerFit.why), JSON.stringify(knownOwnerFit));

// 16) Senior-leadership hires: the CEO is the RIGHT buyer at any size.
t("isSeniorHire: VP of Sales yes, Lead Accountant no", isSeniorHire("VP of Sales") && !isSeniorHire("Lead Accountant"));
const vpHireFit = buyerFit({ company: "Pingidentity", role: "VP of Sales", managerTitle: "Founder & CEO, Ping Identity", employeeCount: 3800 }, know);
t("CEO is rank-0 buyer for a VP hire at a big company", vpHireFit.ok && vpHireFit.rank === 0, JSON.stringify(vpHireFit));

// 17) A C-suite REQ is an executive search: CFO role maps to Executive, CEO buyer passes gates at size.
t("CFO req classifies as Executive family", roleFamily("Chief Financial Officer") === "Executive");
const cfoHire = assessProspect({ company: "Pingidentity", domain: "pingidentity.com", role: "Chief Financial Officer", likelyEmail: "andredurand@pingidentity.com", emailValidated: true, jobLocation: "Denver, Colorado, United States", managerName: "Andre Durand", managerTitle: "Founder & CEO, Ping Identity", employeeCount: 3800 });
t("CEO on a CFO search is held on SIZE only at 3800 heads",
  !cfoHire.eligible && cfoHire.failures.some((f) => /outside the 100-1000/.test(f)) && !cfoHire.failures.some((f) => /decision-maker/.test(f)),
  JSON.stringify(cfoHire.failures));

// 18) Function families unaffected by the executive re-mapping.
t("role families stay intact", roleFamily("Lead Accountant") === "Accounting" && roleFamily("VP of Sales") === "Sales" && roleFamily("Tax Manager") === "Tax" && roleFamily("Assistant to the CFO") !== "Executive");

// 19) The 2026-08-12 "Hi Dedicated," leak: an org string in the name field is not a person,
//     even when the real person's name hides in the title field.
const orgName = assessProspect({ company: "MMD Services", domain: "mmdtech.com", role: "Director of Finance And Accounting", likelyEmail: "dedicated.advocates@mmdtech.com", emailValidated: true, managerName: "Dedicated Advocates.", managerTitle: "Maria Dubov, Founder (a.k.a. The Queen of Staffing)" });
// (assertion widened 2026-08-20: the row IS rejected, but JUNK_TOKEN fires on "Dedicated" before
//  ORG_NAME can, so the reason is "parsed artifact". Either is a correct name-level rejection.)
t("org-string name rejected", !orgName.eligible && orgName.failures.some((f) => /organization, not a person|looks like a parsed artifact, not a person/.test(f)), JSON.stringify(orgName.failures));

// 20) Real people with suffixes/initials still pass the name gates.
const realName = assessProspect({ company: "Acme Manufacturing", domain: "acmemfg.com", role: "Staff Accountant", likelyEmail: "bill.hughes@acmemfg.com", emailValidated: true, managerName: "Bill Hughes Jr.", managerTitle: "Chief Financial Officer", employeeCount: 400 });
t("'Bill Hughes Jr.' still passes", realName.eligible, JSON.stringify(realName.failures));

// ---- Competitor gate + decision-maker rescue (the 2026-08-12 MMD Services send) ----

const mmd = { company: "MMD Services", domain: "mmdtech.com", role: "Director of Finance And Accounting", likelyEmail: "dedicated.advocates@mmdtech.com", emailValidated: true, managerName: "Dedicated Advocates.", managerTitle: "Maria Dubov, Founder (a.k.a. The Queen of Staffing)" };

// 21) Rescue finds the real person buried in the title field.
const fixedMmd = rescueDecisionMaker(mmd);
t("MMD rescue extracts Maria Dubov from the title", fixedMmd && fixedMmd.managerName === "Maria Dubov" && /^Founder/.test(fixedMmd.managerTitle), JSON.stringify(fixedMmd && { name: fixedMmd.managerName, title: fixedMmd.managerTitle }));

// 22) ...and the rescued record is STILL rejected, because the founder's title outs it as a
//     staffing firm. Competitors are never pitched, however clean the person data gets.
const mmdGate = assessProspect({ ...mmd, ...fixedMmd });
t("rescued MMD still rejected as a staffing competitor", !mmdGate.eligible && mmdGate.failures.some((f) => /staffing\/recruiting firm/.test(f)), JSON.stringify(mmdGate.failures));

// 23) Agency tells in every field fire independently.
t("known brand name caught", !!staffingFirmSignal({ company: "Robert Half International" }));
t("agency term in name caught", !!staffingFirmSignal({ company: "Summit Staffing Partners" }));
// The 2026-08-12 searchsvc.com leak: "Search Services" (a Houston finance-recruiting firm).
t("'Search Services' style name caught", !!staffingFirmSignal({ company: "Search Services", domain: "searchsvc.com" }));
t("industry field caught", !!staffingFirmSignal({ company: "Northwind Group", industry: "Staffing and Recruiting" }));
t("agency domain caught", !!staffingFirmSignal({ company: "Apex Partners", domain: "apexstaffing.com" }));

// 24) Legitimate employers never trip it: recruiting-TECH vendors and end employers with a
//     Talent Acquisition exec are clients, not competitors.
t("SmartRecruiters (HR software) passes", staffingFirmSignal({ company: "SmartRecruiters" }) === null);
t("end employer with VP Talent Acquisition passes", staffingFirmSignal({ company: "Ford Motor Company", industry: "Automotive", managerTitle: "VP, Talent Acquisition" }) === null);

// 25) Rescue is precision-biased: fine names untouched, unrecoverable junk stays rejected.
t("clean name never rescued", rescueDecisionMaker({ managerName: "Andre Durand", managerTitle: "Founder & CEO, Ping Identity" }) === null);
t("plain title yields no phantom person", extractPersonFromTitle("Chief Financial Officer") === null && extractPersonFromTitle("VP, Chief Of Staff at Ping Identity") === null);
const unrec = assessProspect({ company: "Acme Corp", domain: "acme.com", role: "Staff Accountant", likelyEmail: "info@acme.com", emailValidated: true, managerName: "Trending Topics", managerTitle: "Welcome to Acme" });
t("unrecoverable junk still rejected", !unrec.eligible, JSON.stringify(unrec.failures));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
