// RecruitersOS · MPC · morning target list compiler.
// Emits every SENDABLE, never-contacted prospect as JSON + a per-family/metro summary,
// ordered hiring-pain first (signal-backed leads on top). Read-only; sends nothing.
//   node /tools/compile-morning-list.mjs            -> /out/morning-list-<date>.json
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { assessProspect, roleFamily } from "./gates.mjs";

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
const rows = [];
for (const r of curated) {
  const p = r.lead || r;
  if (!assessProspect(p).eligible) continue;
  const email = String(p.likelyEmail || "").toLowerCase().trim();
  if (!email || seen.has(email)) continue;
  rows.push({
    company: p.companyName || p.company || "",
    dm: p.managerName || "",
    title: p.managerTitle || "",
    email,
    role: p.role || "",
    family: roleFamily(p.role || ""),
    metro: p.metro || p.location || "",
    signal: p.signalReason || "",
    source: p.discoverySource || "jobs",
    curatedAt: p.curatedAt || "",
  });
}
//

// Signal-backed (news/funding) leads first, then newest curation first.
rows.sort((a, b) => (b.signal ? 1 : 0) - (a.signal ? 1 : 0) || String(b.curatedAt).localeCompare(String(a.curatedAt)));

const byFamily = {}, byMetro = {}, bySource = {};
for (const x of rows) {
  byFamily[x.family] = (byFamily[x.family] || 0) + 1;
  if (x.metro) byMetro[x.metro] = (byMetro[x.metro] || 0) + 1;
  bySource[x.source] = (bySource[x.source] || 0) + 1;
}

const date = new Date().toISOString().slice(0, 10);
const out = { generatedAt: new Date().toISOString(), sendable: rows.length, byFamily, bySource, topMetros: Object.fromEntries(Object.entries(byMetro).sort((a, b) => b[1] - a[1]).slice(0, 15)), rows };
writeFileSync(`${OUT}/morning-list-${date}.json`, JSON.stringify(out, null, 1));
console.log(`sendable now: ${rows.length}`);
console.log("by family:", JSON.stringify(byFamily));
console.log("by source:", JSON.stringify(bySource));
console.log(`wrote /out/morning-list-${date}.json`);
