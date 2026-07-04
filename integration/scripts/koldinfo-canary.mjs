#!/usr/bin/env node
/**
 * KoldInfo UI canary.
 *
 * KoldInfo has no API — we drive it via a CSV round-trip (and, later, a headless browser worker),
 * so a redeploy that renames chunks or changes the upload/export columns can silently break the
 * integration. This canary fingerprints the DEPLOYED build from the outside (no login needed) and
 * flags any change against the stored baseline. It CANNOT see the column layout itself (that lives
 * behind auth) — a changed fingerprint is the signal to log in and re-verify the CSV template + the
 * IMPORT_ALIASES / EXPORT_HEADER in lib/inmarket/koldInfo.ts before the next enrichment run.
 *
 * Usage:
 *   node scripts/koldinfo-canary.mjs            # compare to baseline, exit 0 = same, 3 = CHANGED
 *   node scripts/koldinfo-canary.mjs --update   # write current fingerprint as the new baseline
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, "koldinfo-baseline.json");
const PAGES = ["/", "/sign-in", "/sign-up", "/protected"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

async function get(path) {
  const res = await fetch("https://app.koldinfo.com" + path, { headers: { "User-Agent": UA }, redirect: "follow" });
  return { status: res.status, html: await res.text() };
}

/** A build fingerprint that is stable across content but changes on any redeploy. */
async function fingerprint() {
  const chunks = new Set();
  let deployId = null;
  const actionIds = new Set();
  for (const p of PAGES) {
    const { html } = await get(p).catch(() => ({ html: "" }));
    for (const m of html.matchAll(/static\/chunks\/([a-zA-Z0-9/_.-]+\.js)/g)) chunks.add(m[1].replace(/\?.*$/, ""));
    const dpl = html.match(/dpl_[A-Za-z0-9]+/); if (dpl) deployId = dpl[0];
    for (const m of html.matchAll(/\$ACTION_ID_([a-f0-9]{20,})/g)) actionIds.add(m[1]);
  }
  const sortedChunks = [...chunks].sort();
  const sortedActions = [...actionIds].sort();
  const hash = createHash("sha256").update(JSON.stringify({ sortedChunks, sortedActions })).digest("hex").slice(0, 16);
  return { deployId, chunks: sortedChunks, actionIds: sortedActions, hash };
}

const fp = await fingerprint();
const update = process.argv.includes("--update");

if (update || !existsSync(BASELINE)) {
  writeFileSync(BASELINE, JSON.stringify({ ...fp, capturedAt: new Date().toISOString() }, null, 2) + "\n");
  console.log((existsSync(BASELINE) ? "Updated" : "Wrote") + " baseline:", fp.hash, "(" + fp.chunks.length + " chunks)");
  process.exit(0);
}

const base = JSON.parse(readFileSync(BASELINE, "utf8"));
if (base.hash === fp.hash) {
  console.log("OK — KoldInfo UI unchanged (" + fp.hash + ", " + fp.chunks.length + " chunks).");
  process.exit(0);
}

console.log("CHANGED — KoldInfo redeployed. Re-verify the CSV template + koldInfo.ts column aliases before the next run.");
console.log("  baseline:", base.hash, "@", base.capturedAt, "(" + base.chunks.length + " chunks, dpl " + base.deployId + ")");
console.log("  current :", fp.hash, "(" + fp.chunks.length + " chunks, dpl " + fp.deployId + ")");
const added = fp.chunks.filter((c) => !base.chunks.includes(c));
const removed = base.chunks.filter((c) => !fp.chunks.includes(c));
if (added.length) console.log("  + " + added.join("\n  + "));
if (removed.length) console.log("  - " + removed.join("\n  - "));
process.exit(3);
