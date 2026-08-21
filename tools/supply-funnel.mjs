#!/usr/bin/env node
/**
 * supply-funnel.mjs — where the JSearch-to-send machine actually loses rows (read-only).
 *
 * One question: of everything the job feed brings in, what fraction reaches a mailable person, and
 * at which stage does the rest die? Reports the curation funnel, the address-tier split (the
 * no-guessing rule only lets FOUND addresses send), and the buyer-pairing quality (is the named
 * person the OWNER of the req's function, or a fallback).
 */
import { readFileSync } from "node:fs";

const CURATION = process.env.MPC_CURATION_FILE || "/data/snap_inmarket_curation_v1.json";
const SIZE = process.env.MPC_SIZE_SNAPSHOT || "/data/snap_inmarket_company_size_v1.json";
const SINCE = process.env.MPC_CURATED_SINCE || "2026-08-11";

function loadArray(file) {
  const s = JSON.parse(readFileSync(file, "utf8"));
  const arrs = [];
  const walk = (o) => {
    if (Array.isArray(o)) { if (o.length && typeof o[0] === "object") arrs.push(o); }
    else if (o && typeof o === "object") for (const v of Object.values(o)) walk(v);
  };
  walk(s);
  return arrs.sort((a, b) => b.length - a.length)[0] || [];
}

const all = loadArray(CURATION);
const rows = all.filter((r) => String((r.lead || r).curatedAt || "") >= SINCE);

// MUST mirror tools/fuse.mjs FOUND_SOURCES exactly. The first version of this file invented a wider
// set (validated_external, finder_service, icypeas, laxis) and overstated the sendable tier by more
// than 2x. validated_external is a DERIVED pattern that a verifier blessed; the sender classifies it
// as PATTERN tier and the no-guessing rule will not mail it. Import the truth, do not restate it.
import { FOUND_SOURCES } from "/tools/fuse.mjs";
const FOUND = FOUND_SOURCES;
const pct = (n, d) => (d ? `${(n / d * 100).toFixed(1)}%` : "n/a");
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

const status = new Map(), tier = new Map(), src = new Map();
let named = 0, withEmail = 0, foundEmail = 0, withDomain = 0, withSize = 0;

for (const r of rows) {
  const p = r.lead || r;
  bump(status, p.status || "(none)");
  if (p.managerName) named++;
  if (p.domain) withDomain++;
  if (p.employeeCount != null) withSize++;
  if (p.likelyEmail) {
    withEmail++;
    const s = p.emailSource || "guess";
    bump(src, s);
    const t = FOUND.has(s) ? "found" : "pattern";
    bump(tier, t);
    if (t === "found") foundEmail++;
  }
}

console.log(`\n=== SUPPLY FUNNEL (curated rows since ${SINCE}) ===\n`);
console.log(`curated rows                 ${rows.length}`);
console.log(`  with a company domain      ${withDomain}  (${pct(withDomain, rows.length)})`);
console.log(`  with a confirmed headcount ${withSize}  (${pct(withSize, rows.length)})`);
console.log(`  with a NAMED person        ${named}  (${pct(named, rows.length)})`);
console.log(`  with ANY address           ${withEmail}  (${pct(withEmail, rows.length)})`);
console.log(`  with a FOUND address       ${foundEmail}  (${pct(foundEmail, rows.length)})   <- the only tier that can send`);

console.log(`\n-- curation status --`);
for (const [k, v] of [...status].sort((a, b) => b[1] - a[1])) console.log(`  ${String(k).padEnd(14)} ${String(v).padStart(6)}  ${pct(v, rows.length)}`);

console.log(`\n-- address tier (of ${withEmail} with an address) --`);
for (const [k, v] of [...tier].sort((a, b) => b[1] - a[1])) console.log(`  ${String(k).padEnd(14)} ${String(v).padStart(6)}  ${pct(v, withEmail)}`);

console.log(`\n-- address source --`);
for (const [k, v] of [...src].sort((a, b) => b[1] - a[1])) console.log(`  ${String(k).padEnd(24)} ${String(v).padStart(6)}  ${pct(v, withEmail)}${FOUND.has(k) ? "  [found]" : ""}`);

// Where the drop happens, stage by stage, as a single readable chain.
console.log(`\n-- the chain --`);
const stages = [
  ["curated rows", rows.length],
  ["domain resolved", withDomain],
  ["person named", named],
  ["address built", withEmail],
  ["address FOUND (sendable tier)", foundEmail],
];
let prev = null;
for (const [label, n] of stages) {
  const drop = prev == null ? "" : `  (kept ${pct(n, prev)} of prior stage)`;
  console.log(`  ${label.padEnd(32)} ${String(n).padStart(6)}${drop}`);
  prev = n;
}

// Headcount coverage vs the band, since curation refuses to enrich confirmed-out-of-band companies.
const sizeSnap = (() => { try { return JSON.parse(readFileSync(SIZE, "utf8")); } catch { return {}; } })();
const sizeMap = (sizeSnap && (sizeSnap.data || sizeSnap)) || {};
let inBand = 0, above = 0, below = 0, ext = 0;
for (const v of Object.values(sizeMap)) {
  const n = v && typeof v.count === "number" ? v.count : null;
  if (n == null || n <= 0) continue;
  if (n < 100) below++;
  else if (n <= 1000) inBand++;
  else if (n <= 2500) ext++;
  else above++;
}
console.log(`\n-- company-size cache (${Object.keys(sizeMap).length} companies) --`);
console.log(`  under 100          ${below}   (curation SKIPS these before enrichment)`);
console.log(`  100-1000 in band   ${inBand}`);
console.log(`  1001-2500          ${ext}   (gates allow with a named owner, but curation never enriches them)`);
console.log(`  over 2500          ${above}`);
