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
const { enrichCsv, CONFIG } = require("./laxis-flow");

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.LAXIS_WORKER_TOKEN || "";
const MAX_BODY = 24 * 1024 * 1024; // 24 MB — generous for a big candidate CSV

/** jobId -> { status, stage, createdAt, startedAt, finishedAt, enrichedCsv, error, log[] } */
const jobs = new Map();
const queue = [];
let running = false;

function newId() {
  return "laxisjob_" + crypto.randomBytes(8).toString("hex");
}

function stampLog(job, line) {
  job.stage = line;
  job.log.push(`${new Date().toISOString()} ${line}`);
  if (job.log.length > 200) job.log.shift();
}

async function drain() {
  if (running) return;
  const id = queue.shift();
  if (!id) return;
  const job = jobs.get(id);
  if (!job) return drain();
  running = true;
  job.status = "running";
  job.startedAt = new Date().toISOString();
  try {
    const enrichedCsv = await enrichCsv(job.csv, { log: (l) => stampLog(job, l) });
    job.enrichedCsv = enrichedCsv;
    job.status = "done";
  } catch (err) {
    job.error = (err && err.message) || String(err);
    job.status = "error";
    stampLog(job, "error: " + job.error);
  } finally {
    job.finishedAt = new Date().toISOString();
    job.csv = undefined; // free the input bytes once consumed
    running = false;
    // Forget finished jobs after an hour so memory doesn't grow unbounded.
    const keepUntil = Date.now() + 60 * 60 * 1000;
    job.expiresAt = keepUntil;
    setImmediate(drain);
  }
}

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expiresAt && job.expiresAt < now) jobs.delete(id);
  }
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
      return send(res, 200, { ok: true, hasCreds: Boolean(CONFIG.email && CONFIG.password), queued: queue.length, running });
    }

    if (!authed(req)) return send(res, 401, { error: "unauthorized" });

    if (req.method === "POST" && url.pathname === "/jobs") {
      const raw = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return send(res, 422, { error: "invalid_json" }); }
      const csv = parsed && parsed.csv;
      if (typeof csv !== "string" || !csv.trim()) return send(res, 422, { error: "missing_csv" });
      const id = newId();
      jobs.set(id, {
        id, status: "queued", stage: "queued", csv,
        createdAt: new Date().toISOString(), log: [],
      });
      queue.push(id);
      setImmediate(drain);
      return send(res, 202, { jobId: id });
    }

    const m = url.pathname.match(/^\/jobs\/([^/]+)$/);
    if (req.method === "GET" && m) {
      sweep();
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: "job_not_found" });
      return send(res, 200, {
        jobId: job.id,
        status: job.status,
        stage: job.stage,
        enrichedCsv: job.status === "done" ? job.enrichedCsv : undefined,
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
});
