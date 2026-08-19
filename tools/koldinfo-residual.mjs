/**
 * RecruiterOS · KoldInfo residual email finder — hands-free orchestrator.
 *
 * Drives the round-trip the operator used to do by hand, one bounded step per
 * invocation (a systemd timer fires this every 10 minutes):
 *
 *   1. no job in flight -> GET /api/in-market/koldinfo?mode=all (cron-authed) and
 *      submit the next untried chunk (named rows only) to the laxis-worker's
 *      zero-credit KoldInfo DB flow (kind "koldinfo-db", name + city/state).
 *   2. job in flight    -> poll it; when done, POST the result CSV back to
 *      /api/in-market/koldinfo. The app Reoon re-verifies every address and
 *      promotes rescued rows to contactable (KoldInfo rescue, main e22873fc /
 *      a12f731a) — which refills MPC sending AND the video render queue.
 *
 * A tried-ledger (/out/koldinfo-residual-state.json) stops misses from being
 * re-submitted forever; they get one retry after RETRY_DAYS. Runs inside the
 * app image on the compose network, so no secret ever leaves the box:
 *   docker run --rm --network recruiteros_default \
 *     -v /opt/recruiteros/tools:/tools:ro -v /opt/recruiteros/mpc-out:/out \
 *     --env-file /opt/recruiteros/.env.production \
 *     --entrypoint node recruiteros-app /tools/koldinfo-residual.mjs
 */

import fs from "node:fs";

const APP = (process.env.KOLDINFO_RESIDUAL_APP_URL || "http://app:3000").replace(/\/+$/, "");
const WORKER = (process.env.LAXIS_WORKER_URL || "http://laxis-worker:3000").replace(/\/+$/, "");
const SECRET = process.env.RECRUITEROS_CRON_SECRET || "";
const TOKEN = process.env.LAXIS_WORKER_TOKEN || process.env.WORKER_TOKEN || "";
const STATE_PATH = "/out/koldinfo-residual-state.json";
const CHUNK = Math.max(50, Number(process.env.KOLDINFO_RESIDUAL_CHUNK || 1500));
const RETRY_DAYS = Math.max(1, Number(process.env.KOLDINFO_RESIDUAL_RETRY_DAYS || 45));
const PRUNE_DAYS = 120;

const log = (...a) => console.log(new Date().toISOString(), "[koldinfo-residual]", ...a);
const fail = (msg) => { log("ERROR:", msg); process.exit(1); };

if (!SECRET) fail("RECRUITEROS_CRON_SECRET missing from env");
if (!TOKEN) fail("LAXIS_WORKER_TOKEN missing from env");

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return { job: null, tried: {} }; }
}
function saveState(s) {
  fs.writeFileSync(STATE_PATH + ".tmp", JSON.stringify(s));
  fs.renameSync(STATE_PATH + ".tmp", STATE_PATH);
}

async function http(url, opts = {}, timeoutMs = 60_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
    return { status: res.status, body };
  } finally { clearTimeout(t); }
}

const appHeaders = { "x-cron-secret": SECRET, "content-type": "application/json" };
const workerHeaders = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

/** "Oakland, CA" -> {city, state}; "Remote, USA"/bare "Remote" -> blanks (flow then corroborates by company). */
function splitLocation(loc) {
  const s = (loc || "").trim();
  if (!s || /^remote\b/i.test(s)) return { city: "", state: "" };
  const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
  const city = parts[0] || "";
  let state = parts[1] || "";
  if (/^(usa|united states)$/i.test(state)) state = "";
  return { city: /^remote$/i.test(city) ? "" : city, state };
}

function csvCell(v) {
  const s = String(v ?? "").replace(/\r?\n/g, " ").trim();
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildDbCsv(rows) {
  const lines = ["ros_id,full_name,company,title,city,state"];
  for (const r of rows) {
    const { city, state } = splitLocation(r.location);
    lines.push([r.rosId, r.fullName, r.company, r.title, city, state].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

const now = Date.now();
const state = loadState();

// Prune ledger entries old enough that a future export would retry them anyway.
for (const [id, at] of Object.entries(state.tried || {})) {
  if (now - Date.parse(at) > PRUNE_DAYS * 86_400_000) delete state.tried[id];
}

if (state.job?.id) {
  // ---- a job is in flight: poll it, import on done -------------------------------
  const { status, body } = await http(`${WORKER}/jobs/${state.job.id}`, { headers: workerHeaders });
  if (status === 404) {
    log(`job ${state.job.id} vanished from the worker (restart/expiry) — will resubmit next tick`);
    state.job = null; saveState(state); process.exit(0);
  }
  if (status !== 200) fail(`worker poll HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);

  if (body.status === "done") {
    const csv = body.enrichedCsv || "";
    const rowCount = csv ? csv.trim().split("\n").length - 1 : 0;
    log(`job ${state.job.id} done: ${rowCount} result rows — importing`);
    const imp = await http(`${APP}/api/in-market/koldinfo`, {
      method: "POST", headers: appHeaders, body: JSON.stringify({ csv }),
    }, 15 * 60_000);
    if (imp.status !== 200 || !imp.body?.ok) fail(`import HTTP ${imp.status}: ${JSON.stringify(imp.body).slice(0, 300)}`);
    const s = imp.body;
    log(`imported: parsed=${s.parsed} matched=${s.matched} named=${s.named} FOUND=${s.found} catchAll=${s.catchAll} invalid=${s.invalid} pending=${s.pending} unmatched=${s.unmatched}`);
    const at = new Date().toISOString();
    for (const id of state.job.ids || []) state.tried[id] = at;
    state.lastImport = { at, ...{ parsed: s.parsed, matched: s.matched, found: s.found, invalid: s.invalid, pending: s.pending } };
    state.job = null;
    saveState(state);
  } else if (body.status === "error") {
    log(`job ${state.job.id} ERRORED after retries: ${String(body.error || "").slice(0, 200)} — marking chunk tried so it cannot loop`);
    const at = new Date().toISOString();
    for (const id of state.job.ids || []) state.tried[id] = at;
    state.job = null;
    saveState(state);
    process.exit(1);
  } else {
    log(`job ${state.job.id} ${body.status}/${body.stage || ""} ${body.phase || ""} — waiting`);
  }
  process.exit(0);
}

// ---- no job in flight: export the pile and submit the next chunk -----------------
const exp = await http(`${APP}/api/in-market/koldinfo?mode=all&limit=20000`, { headers: appHeaders }, 120_000);
if (exp.status !== 200 || !exp.body?.ok) fail(`export HTTP ${exp.status}: ${JSON.stringify(exp.body).slice(0, 300)}`);
const all = exp.body.rows || [];
const cutoff = now - RETRY_DAYS * 86_400_000;
const eligible = all.filter((r) => (r.fullName || "").trim().includes(" ")
  && (!state.tried[r.rosId] || Date.parse(state.tried[r.rosId]) < cutoff));

if (!eligible.length) {
  log(`idle: pile swept (${all.length} exported, all tried within ${RETRY_DAYS}d or unnamed)`);
  saveState(state);
  process.exit(0);
}

const chunk = eligible.slice(0, CHUNK);
const csv = buildDbCsv(chunk);
const sub = await http(`${WORKER}/jobs`, { method: "POST", headers: workerHeaders, body: JSON.stringify({ kind: "koldinfo-db", csv }) });
if (sub.status !== 202 || !sub.body?.jobId) fail(`submit HTTP ${sub.status}: ${JSON.stringify(sub.body).slice(0, 200)}`);
state.job = { id: sub.body.jobId, ids: chunk.map((r) => r.rosId), submittedAt: new Date().toISOString() };
saveState(state);
log(`submitted job ${sub.body.jobId}: ${chunk.length} rows (${eligible.length} eligible of ${all.length} exported)${sub.body.deduped ? " [deduped]" : ""}`);
