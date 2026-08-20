import { readFileSync } from "node:fs";
import { assessProspect, roleFamily, roleFunctionGroup, dmFunction, isSeniorHire } from "/tools/gates.mjs";
const pct = (n, d) => d ? (100 * n / d).toFixed(1) + "%" : "-";
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const top = (m, n = 12) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

const rows = JSON.parse(readFileSync("/data/snap_inmarket_curation_v1.json", "utf8"));
const snap = JSON.parse(readFileSync("/data/snap_inmarket_company_size_v1.json", "utf8"));
const norm = (s) => String(s || "").toLowerCase().replace(/\b(inc|llc|ltd|corp|co|company|group|holdings)\b/g, " ").replace(/[^a-z0-9]+/g, "").trim();
const sizeBy = new Map();
for (const [k, v] of Object.entries(snap.data || snap)) if (v && typeof v.count === "number" && v.count > 0) sizeBy.set(norm(k), v.count);

const MIN = 100, MAX = 1000;
let unconfirmed = 0, tooSmall = 0, tooBig = 0, inBand = 0;
const cos = new Map();
for (const r of rows) {
  const c = sizeBy.get(norm(r.company));
  if (c == null) { unconfirmed++; cos.set(r.company, 1); }
  else if (c < MIN) tooSmall++;
  else if (c > MAX) tooBig++;
  else inBand++;
}
console.log("=== SIZE STATUS across", rows.length, "curated rows ===");
console.log("inside 100-1,000      :", inBand, pct(inBand, rows.length));
console.log("confirmed too SMALL   :", tooSmall, pct(tooSmall, rows.length));
console.log("confirmed too BIG     :", tooBig, pct(tooBig, rows.length));
console.log("size still UNCONFIRMED:", unconfirmed, pct(unconfirmed, rows.length), "across", cos.size, "companies (recoverable by the resolver)");

// Of the rows that are INSIDE the band, why are they still not sendable?
const inBandRows = rows.filter((r) => { const c = sizeBy.get(norm(r.company)); return c != null && c >= MIN && c <= MAX; });
const reasons = new Map();
let ok = 0;
for (const r of inBandRows) {
  const p = {
    company: r.company, role: r.role, managerName: r.managerName, managerTitle: r.managerTitle,
    industry: r.industry, domain: r.domain, employeeCount: sizeBy.get(norm(r.company)),
    likelyEmail: r.likelyEmail || r.email, emailValidated: r.emailValidated, emailInvalid: r.emailInvalid,
    emailCatchAll: r.emailCatchAll, jobLocation: r.jobLocation,
    companyBuyerRow: /_buyer_/.test(String(r.id || "")),
  };
  const v = assessProspect(p);
  if (v.eligible) { ok++; continue; }
  for (const f of v.failures) {
    if (/company-level buyer/.test(f)) bump(reasons, "buyer row, not the req owner");
    else if (/whole-company exec/.test(f)) bump(reasons, "CEO/founder, not the req owner");
    else if (/names no function/.test(f)) bump(reasons, "DM title names no function");
    else if (/owns .*, not the/.test(f)) bump(reasons, "DM owns a different function");
    else if (/no named decision-maker/.test(f)) bump(reasons, "no decision-maker named yet");
    else if (/not a professional hire/.test(f)) bump(reasons, "role family unrecognised");
    else if (/email/.test(f)) bump(reasons, "email (missing/unvalidated/catch-all)");
    else if (/staffing\/recruiting firm/.test(f)) bump(reasons, "staffing competitor");
    else bump(reasons, f.slice(0, 46));
  }
}
console.log("\n=== of the", inBandRows.length, "IN-BAND rows, what still blocks them ===");
console.log("fully eligible:", ok);
for (const [k, v] of top(reasons)) console.log(`  ${String(v).padStart(5)}  ${k}`);

// Where the owner is ALREADY named at an in-band company but we were pointing at someone else.
const byCo = new Map();
for (const r of inBandRows) {
  const k = String(r.company || "").toLowerCase();
  if (!byCo.has(k)) byCo.set(k, []);
  byCo.get(k).push(r);
}
let recoverable = 0;
for (const [, list] of byCo) {
  const owners = new Set();
  for (const r of list) { const f = dmFunction(r.managerTitle); if (f && f !== "universal" && r.managerName) owners.add(f); }
  for (const r of list) {
    const rf = roleFunctionGroup(roleFamily(r.role));
    const f = dmFunction(r.managerTitle);
    if ((f === "universal" || /_buyer_/.test(String(r.id || ""))) && owners.has(rf)) recoverable++;
  }
}
console.log("\nin-band rows pointing at a CEO/buyer where THIS company's function owner is already named:", recoverable);
