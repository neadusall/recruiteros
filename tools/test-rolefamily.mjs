/**
 * RecruitersOS · roleFamily regression suite (2026-08-21).
 *
 * The professional-office families added on 2026-08-21 run AHEAD of roleFamily's last-resort
 * block, which makes them powerful and dangerous in equal measure: an unguarded verb silently
 * re-homes reqs that were already classified correctly. A diff over all 20,031 curated roles
 * caught exactly that — "Product Designer" reading as Marketing, "Payroll Specialist" as
 * People/HR, "Legal Billing Specialist" as Accounting — none of which any existing test noticed.
 *
 * So this file locks BOTH directions:
 *   RECOVERS — titles that used to fall to "Other" after we had already paid to enrich them.
 *   GUARDS   — titles that must keep the family they already had.
 *
 * Run with `node tools/test-rolefamily.mjs` alongside tools/test-gates.mjs.
 */

import { roleFamily, roleFunctionGroup, candidateType } from "./gates.mjs";

let pass = 0;
const fails = [];

function eq(role, expected, note) {
  const got = roleFamily(role);
  if (got === expected) { pass++; return; }
  fails.push(`${note}\n     role: ${JSON.stringify(role)}\n     expected ${expected}, got ${got}`);
}

/* ------------------------------------------------------------------ */
/* RECOVERS — these were "Other", i.e. enriched then hard-rejected      */
/* ------------------------------------------------------------------ */

// Accounting operations. None of these contain the word "accounting".
eq("Accounts Receivable Specialist", "Accounting", "AR is accounting work");
eq("Accounts Payable Coordinator", "Accounting", "AP is accounting work");
eq("Collections Specialist", "Accounting", "collections is accounting work");
eq("Billing Analyst", "Accounting", "billing is accounting work");
// Healthcare revenue cycle is medical billing. It used to read as Sales because of "revenue".
eq("Revenue Cycle Specialist", "Accounting", "revenue cycle is billing, not sales");

// Credit / financial risk sits on the CFO chain.
eq("Credit Risk Manager", "Finance", "credit risk is a finance seat");
eq("Credit Analyst, US Core", "Finance", "credit analysis is a finance seat");

// Talent + comp + employee relations are People/HR even with no "HR" in the title.
eq("Senior Technical Recruiter", "People / HR", "a recruiter req is People/HR");
eq("Compensation Consultant", "People / HR", "compensation is People/HR");
eq("Labor and Employee Relations Business Partner", "People / HR", "employee relations is People/HR");

// Advertising / paid media / creative report to the CMO.
eq("Advertising Paid Search Manager", "Marketing", "paid search is marketing");
eq("Associate Director, Paid Social", "Marketing", "paid social is marketing");
eq("Art Director", "Marketing", "creative reports into marketing at this size");
eq("UX Designer", "Marketing", "design reports into marketing at this size");

// IT / internal systems shares the technology leader with engineering.
eq("Senior IT Support Analyst", "Engineering", "IT support is the technology leader's remit");
eq("Salesforce Administrator", "Engineering", "internal systems admin is technical");
eq("Cybersecurity Threat & Vulnerability Analyst", "Engineering", "security is technical");

// Presales carries the number; implementation is post-sale delivery.
eq("Senior Solutions Consultant", "Sales", "presales belongs to Sales");
eq("Implementation Specialist", "Customer Success", "implementation is post-sale delivery");

// Executive support with no function named falls to Operations.
eq("Executive Assistant", "Operations", "an unqualified EA req is an Operations seat");

/* ------------------------------------------------------------------ */
/* GUARDS — these must KEEP the family they already had                */
/* ------------------------------------------------------------------ */

// The design branch must not swallow product or engineering reqs.
eq("Product Designer", "Product", "a product designer is a Product req");
eq("Senior Product Designer", "Product", "a product designer is a Product req");
eq("Software UX/UI Design Lead", "Engineering", "a software design lead is an Engineering req");

// Payroll stays on the CFO chain even when the title also says "benefits".
eq("Payroll Specialist", "Finance", "payroll is a finance seat");
eq("Payroll & Benefits Administrator", "Finance", "payroll wins over the benefits half");

// Law-firm billing is Legal, not Accounting.
eq("Legal Billing Specialist", "Legal", "legal billing stays with Legal");
eq("Legal Billing Manager", "Legal", "legal billing stays with Legal");

// A clinical-trials recruiter is not a talent hire.
eq("Patient Recruiter", "Healthcare", "a patient recruiter is a clinical seat");

// Executive support must NOT outrank a named function: the owner chain has to keep pointing at
// the leader that seat supports, which is the whole reason that branch runs dead last.
eq("Executive Assistant, Finance", "Finance", "an EA to finance keeps the CFO as owner");
eq("Chief of Staff, Data", "Data", "a chief of staff to data keeps the data leader as owner");
eq("Legal Administrative Assistant", "Legal", "a legal admin keeps the GC as owner");

// Core families the earlier patterns own must be untouched.
eq("Controller", "Accounting", "controller is still accounting");
eq("Document Controller", "Other", "document control is still not a finance seat");
eq("Staff Accountant", "Accounting", "core accounting unchanged");
eq("VP of Finance", "Finance", "core finance unchanged");
eq("Registered Nurse", "Healthcare", "clinical unchanged");
eq("Account Executive", "Sales", "core sales unchanged");
eq("Software Engineer", "Engineering", "core engineering unchanged");

/* ------------------------------------------------------------------ */
/* Every recovered family must route to a real owner + pitch line      */
/* ------------------------------------------------------------------ */

// A family with no owner chain would just trade a role-family rejection for an
// owns-the-wrong-function one, which is exactly what adding a "Design" family would have done.
for (const fam of ["Accounting", "Finance", "People / HR", "Marketing", "Engineering", "Sales", "Customer Success", "Operations"]) {
  const group = roleFunctionGroup(fam);
  if (!group || group === "Other") fails.push(`family ${fam} has no function group`);
  else pass++;
  if (!candidateType(sampleFor(fam))) fails.push(`family ${fam} has no candidate pitch line`);
  else pass++;
}

function sampleFor(fam) {
  switch (fam) {
    case "Accounting": return "Staff Accountant";
    case "Finance": return "VP of Finance";
    case "People / HR": return "Senior Technical Recruiter";
    case "Marketing": return "Art Director";
    case "Engineering": return "Software Engineer";
    case "Sales": return "Account Executive";
    case "Customer Success": return "Implementation Specialist";
    case "Operations": return "Executive Assistant";
    default: return "";
  }
}

if (fails.length) {
  console.error(`\n${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.error(`  x  ${f}\n`);
  process.exit(1);
}
console.log(`${pass} passed`);
