// RecruitersOS: activate the warm-ready Zapmail Google boxes (owner order 2026-08-19).
// Mirrors lib/senders/store.ts setStatus() semantics exactly: status -> active, clear
// auto-hold, reset recover streak, rebase guard counters, stamp updatedAt.
// RUN ONLY WITH THE APP STOPPED (snapshot clobber trap), then force-recreate the app.
//   docker run --rm -v recruiteros_app_data:/data -v /opt/recruiteros/tools:/tools:ro \
//     --entrypoint node recruiteros-app /tools/activate-zapmail.mjs
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

const READY_FILE = "/tools/zapmail-ready.json";
const SNAP = "/data/snap_senders_v1.json";
const WS = "ws_mqf6o989003"; // Lume workspace; Zapmail fleet lives here

if (!existsSync(READY_FILE) || !existsSync(SNAP)) { console.log("missing input file; nothing to do"); process.exit(1); }
const ready = new Set(JSON.parse(readFileSync(READY_FILE, "utf8")).map((e) => String(e).toLowerCase()));
console.log(`ready list: ${ready.size} boxes`);

const snap = JSON.parse(readFileSync(SNAP, "utf8"));
// Locate the inbox array wherever it sits in the snapshot shape.
let inboxes = null;
const walk = (o) => {
  if (inboxes || !o) return;
  if (Array.isArray(o)) {
    if (o.length && o[0] && typeof o[0] === "object" && "email" in o[0] && "workspaceId" in o[0]) inboxes = o;
    return;
  }
  if (typeof o === "object") for (const v of Object.values(o)) walk(v);
};
walk(snap);
if (!inboxes) { console.log("could not locate inbox array in snapshot; aborting with no changes"); process.exit(1); }
console.log(`snapshot inboxes: ${inboxes.length}`);

let activated = 0, alreadyActive = 0, notFound = new Set(ready);
const now = new Date().toISOString();
for (const m of inboxes) {
  const em = String(m.email || "").toLowerCase();
  if (m.workspaceId !== WS || !ready.has(em)) continue;
  notFound.delete(em);
  if (m.status === "active") { alreadyActive++; continue; }
  m.status = "active";
  m.pausedReason = undefined;
  m.autoHold = false;
  m.autoHoldReason = undefined;
  m.recoverStreak = 0;
  m.guardBaseSent = m.sent || 0;
  m.guardBaseBounced = m.bounced || 0;
  m.updatedAt = now;
  activated++;
}
if (activated) {
  const tmp = `${SNAP}.repair.tmp`;
  writeFileSync(tmp, JSON.stringify(snap));
  renameSync(tmp, SNAP);
}
console.log(`activated: ${activated} | already active: ${alreadyActive} | not in pool: ${notFound.size}`);
if (notFound.size) console.log("missing from pool:", [...notFound].slice(0, 60).join(", "));
