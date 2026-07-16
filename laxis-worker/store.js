/**
 * RecruiterOS · Laxis worker — durable job store.
 *
 * The worker's job list used to live only in memory, so a restart mid-job (crash, OOM,
 * redeploy, autoheal) lost the in-flight browser job: the app polled and got a 404, the
 * chunk was stranded, and re-running re-grabbed data Laxis had already enriched (wasted
 * credits + time). This module persists every job to the `/data` volume — the same volume
 * that holds the Laxis session — so jobs survive a restart and can be RESUMED instead of
 * re-run.
 *
 * Layout (one dir per worker, on the persistent volume):
 *   /data/laxis-jobs/<jobId>.json        — job metadata (status, phase, token, timestamps)
 *   /data/laxis-jobs/<jobId>.input.csv   — the input CSV (kept until the job is terminal)
 *   /data/laxis-jobs/<jobId>.result.csv  — the enriched CSV (written once on completion)
 *
 * Heavy bytes (input/result) live in their own files, never inline in the JSON, so the
 * metadata stays tiny and a corrupt/huge result can't poison the job index.
 *
 * Everything here is best-effort and synchronous: a failed disk write logs and continues
 * (the in-memory job is still authoritative for the live process) — durability degrades
 * gracefully rather than taking the worker down.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DIR = process.env.LAXIS_JOBS_DIR || "/data/laxis-jobs";

// Fields that are safe + useful to persist. Bytes (csv/enrichedCsv) are stored as files.
// `kind` MUST persist: without it a job recovered after a restart fell back to the
// default Laxis flow - a koldinfo-db job would resume through the WRONG browser flow.
// `checkpoint` is the flow's own resume state (e.g. the DB lookup's done-batch cursor).
const META_FIELDS = [
  "id", "kind", "token", "status", "stage", "phase", "count", "attempts", "hash",
  "createdAt", "startedAt", "finishedAt", "expiresAt", "error", "laxisViewUrl", "checkpoint",
];

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* best effort */ }
}

function metaPath(id) { return path.join(DIR, id + ".json"); }
function inputPath(id) { return path.join(DIR, id + ".input.csv"); }
function resultPath(id) { return path.join(DIR, id + ".result.csv"); }

/** Persist a job's metadata + its log tail. Never throws. */
function save(job) {
  ensureDir();
  const meta = {};
  for (const f of META_FIELDS) if (job[f] !== undefined) meta[f] = job[f];
  meta.log = (job.log || []).slice(-40); // keep a short tail for post-mortem
  // Atomic-ish write: tmp then rename, so a crash mid-write can't leave half a file.
  const tmp = metaPath(job.id) + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(meta));
    fs.renameSync(tmp, metaPath(job.id));
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    console.log("[store] save failed for", job.id, err && err.message);
  }
}

function writeInput(id, csv) {
  ensureDir();
  try { fs.writeFileSync(inputPath(id), csv, "utf8"); } catch (err) { console.log("[store] writeInput failed", id, err && err.message); }
}
function readInput(id) {
  try { return fs.readFileSync(inputPath(id), "utf8"); } catch { return null; }
}
function writeResult(id, csv) {
  ensureDir();
  const tmp = resultPath(id) + ".tmp";
  try { fs.writeFileSync(tmp, csv, "utf8"); fs.renameSync(tmp, resultPath(id)); }
  catch (err) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } console.log("[store] writeResult failed", id, err && err.message); }
}
function readResult(id) {
  try { return fs.readFileSync(resultPath(id), "utf8"); } catch { return null; }
}

/** Remove every file for a job. Called when a finished job is swept past retention. */
function remove(id) {
  for (const p of [metaPath(id), inputPath(id), resultPath(id)]) {
    try { fs.unlinkSync(p); } catch { /* not there */ }
  }
}

/** Drop just the input CSV once it is no longer needed (keeps PII on disk minimal). */
function dropInput(id) {
  try { fs.unlinkSync(inputPath(id)); } catch { /* not there */ }
}

/**
 * Load every persisted job back into memory at boot. Returns an array of job objects
 * (metadata only — input/result are read from disk on demand). A job file that can't be
 * parsed is skipped (and removed) rather than crashing the worker.
 */
function loadAll() {
  ensureDir();
  let names = [];
  try { names = fs.readdirSync(DIR).filter((n) => n.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const n of names) {
    const id = n.slice(0, -5);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(DIR, n), "utf8"));
      meta.log = Array.isArray(meta.log) ? meta.log : [];
      out.push(meta);
    } catch {
      console.log("[store] unreadable job file, removing:", n);
      remove(id);
    }
  }
  return out;
}

module.exports = {
  DIR, save, writeInput, readInput, writeResult, readResult, remove, dropInput, loadAll,
  inputPath, resultPath,
};
