/**
 * RecruiterOS · Laxis worker — HTTP service.
 *
 * A tiny, dependency-free HTTP server (only `playwright` is a dep) that the main
 * RecruiterOS app talks to over the internal Docker network — Caddy never exposes it.
 * It mirrors the deep-vet batch shape the app already knows: submit a job, poll it,
 * collect the result.
 *
 *   POST /jobs        { csv }            -> { jobId }            (202, enqueued)
 *   GET  /jobs/:id                       -> { status, stage, enrichedCsv?, error? }
 *   GET  /health                         -> { ok: true, loggedIn }
 *
 * Single concurrency on purpose: one browser session to Laxis at a time looks like
 * one human and minimizes the chance of tripping bot detection. Jobs queue.
 *
 * Auth: if LAXIS_WORKER_TOKEN is set, every request must send it as
 * `Authorization: Bearer <token>`. The app sends the same value.
 */

"use strict";

const http = require("http");
const crypto = require("crypto");
const { runJob, selfTest, CONFIG } = require("./laxis-flow");
const koldinfo = require("./koldinfo-flow");
const store = require("./store");

// Which browser flow runs a job. "laxis" is the default so every pre-`kind` caller
// (and every job persisted before this field existed) behaves exactly as before.
const FLOWS = {
  laxis: { runJob, selfTest },
  koldinfo: { runJob: koldinfo.runJob, selfTest: koldinfo.selfTest },
};

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.LAXIS_WORKER_TOKEN || "";
const MAX_BODY = 24 * 1024 * 1024; // 24 MB — generous for a big candidate CSV
// How long a FINISHED job (done/error) is kept on disk so the app can still collect it
// even if it polls late or was offline. Generous so a result is never lost to a sweep.
const DONE_RETENTION_MS = Number(process.env.LAXIS_DONE_RETENTION_HOURS || 48) * 3600_000;
const MAX_RUN_ATTEMPTS = Number(process.env.LAXIS_MAX_ATTEMPTS || 3);

/** jobId -> { id, token, status, stage, phase, csv?, enrichedCsv?, hash, attempts, ... } */
const jobs = new Map();
const queue = [];
let running = false;
let lastCanary = null;

function newId() {
  return "laxisjob_" + crypto.randomBytes(8).toString("hex");
}
function newToken() {
  return "rosjob-" + crypto.randomBytes(5).toString("hex");
}
function hashCsv(csv) {
  return crypto.createHash("sha256").update(csv).digest("hex");
}

function stampLog(job, line) {
  job.stage = line;
  job.log.push(`${new Date().toISOString()} ${line}`);
  if (job.log.length > 200) job.log.shift();
}

async function drain() {
  if (running) return;
  const id = queue.shift();
  if (id === undefined) return;
  const job = jobs.get(id);
  if (!job || job.status === "done" || job.status === "error") return drain();
  running = true;
  job.status = "running";
  job.attempts = (job.attempts || 0) + 1;
  if (!job.startedAt) job.startedAt = new Date().toISOString();
  // Make sure the input survives a crash so a resumed run can re-read it from disk.
  if (job.csv && store.readInput(id) === null) store.writeInput(id, job.csv);
  if (!job.csv) job.csv = store.readInput(id); // resumed job: rehydrate input from disk
  store.save(job);
  try {
    if (!job.csv) throw new Error("laxis_input_lost: no input CSV on disk to resume from");
    const flow = FLOWS[job.kind] || FLOWS.laxis;
    const enrichedCsv = await flow.runJob(job, {
      log: (l) => { stampLog(job, l); store.save(job); },
      setPhase: (p) => { job.phase = p; store.save(job); },
    });
    job.enrichedCsv = enrichedCsv;
    store.writeResult(id, enrichedCsv);
    job.status = "done";
    store.dropInput(id); // done — drop the input CSV (keeps PII on disk minimal)
  } catch (err) {
    const msg = (err && err.message) || String(err);
    stampLog(job, "error: " + msg);
    // Transient failure (the row already exists on Laxis, so a retry RESUMES — it won't
    // re-grab) → requeue up to MAX_RUN_ATTEMPTS before giving up. A "deep structural"
    // unresolved-step error is not worth retrying; surface it immediately.
    const fatal = /(?:laxis|koldinfo)_(?:step_unresolved|credentials_missing|login_failed|login_form_not_found|no_input_csv|input_lost)/.test(msg);
    if (!fatal && job.attempts < MAX_RUN_ATTEMPTS) {
      job.status = "queued";
      job.error = undefined;
      stampLog(job, `retry: attempt ${job.attempts}/${MAX_RUN_ATTEMPTS} failed, requeueing (will resume by token)`);
      store.save(job);
      running = false;
      setTimeout(() => { queue.push(id); setImmediate(drain); }, 5000).unref();
      return;
    }
    job.error = msg;
    job.status = "error";
  } finally {
    if (job.status === "done" || job.status === "error") {
      job.finishedAt = new Date().toISOString();
      job.csv = undefined; // free the input bytes in memory once consumed
      job.expiresAt = Date.now() + DONE_RETENTION_MS;
      store.save(job);
      running = false;
      setImmediate(drain);
    }
  }
}

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expiresAt && job.expiresAt < now) { jobs.delete(id); store.remove(id); }
  }
}

/**
 * Boot recovery: pull every persisted job back into memory. Jobs that were mid-flight when
 * the worker died (status running/queued, or a non-terminal phase) are re-queued — runJob
 * re-attaches to the Laxis row by token and finishes WITHOUT re-grabbing. Finished jobs are
 * kept (result read from disk) until their retention expires.
 */
function recoverJobs() {
  const persisted = store.loadAll();
  let resumed = 0;
  for (const meta of persisted) {
    const job = { ...meta, csv: undefined, enrichedCsv: undefined, log: meta.log || [] };
    if (job.status === "done" || job.status === "error") {
      // Keep terminal jobs around (don't reset their expiry) so a late poll still collects.
      if (!job.expiresAt) job.expiresAt = Date.now() + DONE_RETENTION_MS;
      jobs.set(job.id, job);
      continue;
    }
    // Non-terminal → resume it. Requeue only if we still have the input to run from.
    if (store.readInput(job.id) === null) {
      job.status = "error";
      job.error = "laxis_input_lost_on_restart: input CSV was not on the volume to resume from";
      job.finishedAt = new Date().toISOString();
      job.expiresAt = Date.now() + DONE_RETENTION_MS;
      jobs.set(job.id, job);
      store.save(job);
      continue;
    }
    job.status = "queued";
    job.error = undefined;
    stampLog(job, "recovered after worker restart — will resume by token " + job.token);
    jobs.set(job.id, job);
    store.save(job);
    queue.push(job.id);
    resumed++;
  }
  sweep(); // drop any terminal jobs that already aged out while the worker was down
  if (resumed) console.log(`[recover] re-queued ${resumed} in-flight job(s) to resume after restart`);
  if (queue.length) setImmediate(drain);
}

function send(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "content-type": "application/json", "content-length": buf.length });
  res.end(buf);
}

function authed(req) {
  if (!TOKEN) return true;
  const h = req.headers["authorization"] || "";
  return h === `Bearer ${TOKEN}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("payload_too_large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, {
        ok: true,
        hasCreds: Boolean(CONFIG.email && CONFIG.password),
        hasKoldinfoCreds: Boolean(koldinfo.CONFIG.email && koldinfo.CONFIG.password),
        queued: queue.length, running, lastCanary,
      });
    }

    if (!authed(req)) return send(res, 401, { error: "unauthorized" });

    // On-demand canary: log in + confirm (and self-heal) the enrich entry point, no credit spent.
    // ?kind=koldinfo exercises the KoldInfo flow instead of the default Laxis one.
    if (req.method === "GET" && url.pathname === "/selftest") {
      try {
        const flow = FLOWS[url.searchParams.get("kind")] || FLOWS.laxis;
        const r = await flow.selfTest({ log: (l) => console.log("[selftest]", l) });
        lastCanary = { ...r, at: new Date().toISOString() };
        return send(res, r.ok ? 200 : 503, lastCanary);
      } catch (err) {
        lastCanary = { ok: false, error: (err && err.message) || String(err), at: new Date().toISOString() };
        return send(res, 503, lastCanary);
      }
    }

    if (req.method === "POST" && url.pathname === "/jobs") {
      const raw = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return send(res, 422, { error: "invalid_json" }); }
      const csv = parsed && parsed.csv;
      if (typeof csv !== "string" || !csv.trim()) return send(res, 422, { error: "missing_csv" });
      const kind = parsed.kind === "koldinfo" ? "koldinfo" : "laxis";
      // Idempotent submit: if an identical CSV is already queued/running (a retried POST
      // after a lost response, say), hand back the SAME job instead of double-grabbing.
      // The kind is part of the identity — the same CSV may legitimately go to both vendors.
      const hash = hashCsv(kind + "\n" + csv);
      for (const j of jobs.values()) {
        if (j.hash === hash && (j.status === "queued" || j.status === "running")) {
          return send(res, 202, { jobId: j.id, deduped: true });
        }
      }
      const id = newId();
      const job = {
        id, kind, token: newToken(), status: "queued", stage: "queued", phase: "new",
        csv, hash, attempts: 0, createdAt: new Date().toISOString(), log: [],
      };
      jobs.set(id, job);
      store.writeInput(id, csv); // persist input up front so a crash before drain can resume
      store.save(job);
      queue.push(id);
      setImmediate(drain);
      return send(res, 202, { jobId: id });
    }

    const m = url.pathname.match(/^\/jobs\/([^/]+)$/);
    if (req.method === "GET" && m) {
      sweep();
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: "job_not_found" });
      // Serve the enriched CSV from disk if it's not in memory (e.g. the job finished in a
      // previous worker process and was only rehydrated as metadata at boot).
      let enrichedCsv;
      if (job.status === "done") enrichedCsv = job.enrichedCsv || store.readResult(job.id) || undefined;
      return send(res, 200, {
        jobId: job.id,
        status: job.status,
        stage: job.stage,
        phase: job.phase,
        attempts: job.attempts,
        enrichedCsv,
        error: job.error,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
      });
    }

    return send(res, 404, { error: "not_found" });
  } catch (err) {
    return send(res, err.status || 500, { error: (err && err.message) || "server_error" });
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`laxis-worker listening on :${PORT} (auth ${TOKEN ? "on" : "off"}, creds ${CONFIG.email ? "set" : "MISSING"})`);
  // Recover any jobs that were in flight when a previous process died — resume them.
  try { recoverJobs(); } catch (err) { console.log("[recover] failed:", (err && err.message) || err); }
});

// Periodic canary: every LAXIS_CANARY_HOURS (default 12h) confirm + pre-emptively heal the
// login + enrich entry point so a Laxis UI change is repaired BEFORE a real job hits it.
// Skipped while a job is running (one browser session at a time) and when creds are absent.
const CANARY_HOURS = Number(process.env.LAXIS_CANARY_HOURS || 12);
if (CANARY_HOURS > 0 && CONFIG.email && CONFIG.password) {
  const tick = async () => {
    if (running) return;
    try {
      const r = await selfTest({ log: (l) => console.log("[canary]", l) });
      lastCanary = { ...r, at: new Date().toISOString() };
      console.log("[canary]", r.ok ? (r.healed ? "ok (self-healed a UI change)" : "ok") : "FAILED to resolve enrich entry point");
    } catch (err) {
      lastCanary = { ok: false, error: (err && err.message) || String(err), at: new Date().toISOString() };
      console.log("[canary] error:", lastCanary.error);
    }
  };
  setTimeout(tick, 90_000).unref();                       // first run shortly after boot
  setInterval(tick, CANARY_HOURS * 3600_000).unref();     // then on the cadence
}
