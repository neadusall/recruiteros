// RecruitersOS · MPC · one-time repair (2026-08-18): mark hard-bounced addresses invalid
// in the curation store, so known-dead emails stop being re-curated, re-written and
// re-suppressed downstream. (They were stamped emailValidated:true by the validation rung
// even though receivers reported user-unknown - see the 8/18 deliverability audit.)
//
// IMPORTANT: the app holds this store in memory and rewrites the snapshot on its own ticks.
// Run this ONLY while the app container is STOPPED, then start the app so it hydrates the
// repaired snapshot (the watch-store clobber trap, learned 8/12).
//   docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro \
//     --entrypoint node recruiteros-app /tools/invalidate-bounced.mjs
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

const NDR_FILE = "/data/snap_mpc_ndr_v1.json";
const CUR_FILE = "/data/snap_inmarket_curation_v1.json";
if (!existsSync(NDR_FILE) || !existsSync(CUR_FILE)) { console.log("missing snapshot; nothing to do"); process.exit(0); }

const ndr = JSON.parse(readFileSync(NDR_FILE, "utf8"));
const bounced = new Set((ndr.bounced || []).map((e) => String(e).toLowerCase()));
if (!bounced.size) { console.log("no bounced addresses recorded; nothing to do"); process.exit(0); }

const cur = JSON.parse(readFileSync(CUR_FILE, "utf8"));
// Curation rows store the address in likelyEmail (email is not a field on these rows; the
// 8/18 run matched zero rows because it read row.email). Accept both plus an object-map store.
const rows = cur.items || (Array.isArray(cur) ? cur : Object.values(cur));
let flagged = 0;
for (const row of rows) {
  const em = String(row && (row.likelyEmail || row.email) || "").toLowerCase();
  if (em && bounced.has(em) && !(row.emailInvalid === true)) {
    row.emailInvalid = true;
    row.emailValidated = false;
    row.emailInvalidReason = "hard bounce (NDR sweep); receiver reported undeliverable";
    flagged++;
  }
}
if (flagged) {
  const tmp = `${CUR_FILE}.repair.tmp`;
  writeFileSync(tmp, JSON.stringify(cur));
  renameSync(tmp, CUR_FILE);
}
console.log(`invalidate-bounced: ${bounced.size} bounced address(es) known, ${flagged} curation row(s) newly marked invalid, snapshot ${flagged ? "written" : "untouched"}`);
