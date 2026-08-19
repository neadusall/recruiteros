// One-shot x-ray of the NON-sendable email buckets: what exactly fails, and how many rows
// carry enough data (DM name + company domain) for an email-finder recovery pass.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { assessProspect } from "./gates.mjs";

const CURATION = process.env.MPC_CURATION_FILE || "/data/snap_inmarket_curation_v1.json";
const OUT = process.env.MPC_OUT_DIR || "/out";
const SINCE = process.env.MPC_CURATED_SINCE || "2026-08-11";

function loadArray(file) {
  const s = JSON.parse(readFileSync(file, "utf8"));
  const arrs = []; const walk = (o) => { if (Array.isArray(o)) { if (o.length && typeof o[0] === "object") arrs.push(o); } else if (o && typeof o === "object") for (const v of Object.values(o)) walk(v); };
  walk(s); return arrs.sort((a, b) => b.length - a.length)[0] || [];
}
function alreadyEmailed() {
  const seen = new Set();
  if (!existsSync(OUT)) return seen;
  for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n)))
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try { const r = JSON.parse(s); if (r && r.to_email) seen.add(String(r.to_email).toLowerCase().trim()); } catch {}
    }
  return seen;
}

const curated = loadArray(CURATION).filter((r) => String((r.lead || r).curatedAt || "") >= SINCE);
const seen = alreadyEmailed();
const failCounts = new Map();
let recoverable = 0, recoverableCatchAll = 0, sample = [];

for (const r of curated) {
  const p = r.lead || r;
  const res = assessProspect(p);
  if (res.eligible) continue;
  const f = res.failures.join(" | ");
  if (/accounting\/finance hire|role\/shared inbox|parsed artifact|decision-maker|different company/.test(f)) continue;
  for (const x of res.failures) failCounts.set(x.replace(/"[^"]*"/g, '"..."').slice(0, 90), (failCounts.get(x.replace(/"[^"]*"/g, '"..."').slice(0, 90)) || 0) + 1);
  const hasDm = p.managerName && String(p.managerName).trim().split(/\s+/).length >= 2;
  const domain = p.companyDomain || p.domain || (String(p.likelyEmail || "").split("@")[1] || "");
  if (hasDm && domain) {
    if (/catch-all/.test(f)) recoverableCatchAll++; else recoverable++;
    if (sample.length < 5) sample.push({ dm: p.managerName, title: p.managerTitle, domain, email: p.likelyEmail, status: p.emailStatus || p.emailValidation || "?", fails: res.failures });
  }
}

console.log("--- failure reasons (email buckets) ---");
for (const [k, v] of [...failCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(6), k);
console.log(`\nrecoverable (DM name + domain, non-catch-all): ${recoverable}`);
console.log(`catch-all with DM name + domain:               ${recoverableCatchAll}`);
console.log("\nsample rows:", JSON.stringify(sample, null, 1));
