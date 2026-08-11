// RecruitersOS · MPC · supply x-ray. Answers ONE question with hard numbers: how many finance
// prospects can we SEND now, and how many more would unlock if we validate more emails (Reoon).
//
// Buckets the curated store against the real send gates:
//   SENDABLE NOW      - passes every gate (minus already-contacted), ready for the writer today.
//   UNLOCK w/ VALIDATE- role OK + real DM + domain-matched email, failing ONLY "not validated".
//                       These convert to SENDABLE the moment Reoon validates them => the credit ask.
//   catch-all / other - not unlockable under the strict gate (kept honest on purpose).
//
//   node scripts/mpc/inspect-supply.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { assessProspect } from "./gates.mjs";

const CURATION = process.env.MPC_CURATION_FILE || "/data/snap_inmarket_curation_v1.json";
const OUT = process.env.MPC_OUT_DIR || "/out";

function loadArray(file) {
  const s = JSON.parse(readFileSync(file, "utf8"));
  const arrs = []; const walk = (o) => { if (Array.isArray(o)) { if (o.length && typeof o[0] === "object") arrs.push(o); } else if (o && typeof o === "object") for (const v of Object.values(o)) walk(v); };
  walk(s); return arrs.sort((a, b) => b.length - a.length)[0] || [];
}
function alreadyEmailed() {
  const seen = new Set();
  if (!existsSync(OUT)) return seen;
  for (const f of readdirSync(OUT).filter((n) => /^sent-.*\.jsonl$/.test(n))) {
    for (const line of readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try { const r = JSON.parse(s); if (r && r.to_email) seen.add(String(r.to_email).toLowerCase().trim()); } catch { /* skip */ }
    }
  }
  return seen;
}

const SINCE = process.env.MPC_CURATED_SINCE || "2026-08-11";
const curatedAll = loadArray(CURATION);
const curated = SINCE ? curatedAll.filter((r) => String((r.lead || r).curatedAt || "") >= SINCE) : curatedAll;
const seen = alreadyEmailed();

let sendableNow = 0, alreadySent = 0, unlockValidate = 0, catchAll = 0, roleFail = 0, dmFail = 0, otherEmail = 0;
for (const r of curated) {
  const p = r.lead || r;
  const res = assessProspect(p);
  const email = String(p.likelyEmail || "").toLowerCase().trim();
  if (res.eligible) { if (email && seen.has(email)) alreadySent++; else sendableNow++; continue; }
  const f = res.failures.join(" | ");
  const roleBad = /accounting\/finance hire|role\/shared inbox|parsed artifact/.test(f);
  const dmBad = /decision-maker|different company/.test(f);
  if (roleBad) { roleFail++; continue; }
  if (dmBad) { dmFail++; continue; }
  // email-only failures:
  if (/catch-all/.test(f)) { catchAll++; continue; }
  // role OK + DM OK + failing only "email not validated" (and nothing else) => unlockable by Reoon.
  const onlyNotValidated = res.failures.every((x) => /not validated/.test(x));
  if (onlyNotValidated && email) { unlockValidate++; continue; }
  otherEmail++;
}

const fmt = (n) => String(n).padStart(6);
console.log(`curated total: ${curatedAll.length} | finance-era (since ${SINCE}): ${curated.length}`);
console.log(`-------------------------------------------`);
console.log(`SENDABLE NOW (fresh):       ${fmt(sendableNow)}   <- ready for the writer today`);
console.log(`already contacted:          ${fmt(alreadySent)}`);
console.log(`UNLOCK w/ validation:       ${fmt(unlockValidate)}   <- Reoon-validate these => sendable`);
console.log(`catch-all (blocked, honest):${fmt(catchAll)}`);
console.log(`other email issue:          ${fmt(otherEmail)}`);
console.log(`role not finance:           ${fmt(roleFail)}`);
console.log(`decision-maker not a buyer: ${fmt(dmFail)}`);
console.log(`-------------------------------------------`);
console.log(`TODAY'S CEILING w/o new validation: ${sendableNow}`);
console.log(`TODAY'S CEILING if we validate the unlock bucket: ${sendableNow + unlockValidate}`);
