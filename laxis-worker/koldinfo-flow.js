/**
 * RecruiterOS · enrichment worker, the KoldInfo browser flow.
 *
 * KoldInfo (app.koldinfo.com) has no API, so this drives its real UI with a headless
 * Chromium, exactly like laxis-flow.js drives app.laxis.tech. KoldInfo is the FREE
 * first rung: this flow runs BEFORE the Laxis job in the auto-enrich chain, so Laxis
 * credits are only spent on what KoldInfo could not fill.
 *
 * ── VERIFIED FLOW (calibrated against the live site 2026-07-15, creds on the box) ──
 * LOGIN: /sign-in, plain email + password form; submit via Enter (a "Sign In"
 *   HEADING also exists, so text-clicking is unreliable, Enter is not).
 * ENRICH: /protected/enrichment ("Upload LinkedIn URLs to Enrich"):
 *   attach the CSV on the hidden input[type=file] → "Loaded N rows." appears →
 *   pick which column has the LinkedIn URLs (ours: linkedin_url) in the FIRST
 *   <select> (options = our CSV headers; second select = source table, default
 *   "All tables") → "Enrich Preview" → a confirmation reads
 *   "Found X matching rows. It will cost X tokens. Proceed?" with Cancel/Confirm.
 *   1 token per matched row. 0 matches → Cancel, nothing spent.
 * RESULT: lands in /protected/exports ("My Exports", newest first) named
 *   "Enrichment_all_<date>.csv"; the row's Download button hands back OUR columns
 *   (ros_id passthrough included) + person_* columns: person_email,
 *   person_email_status_cd (Verified/…), person_phone, person_sanitized_phone
 *   (E.164), person_location_*, person_title. So KoldInfo returns EMAILS AND
 *   PHONES (line type unknown; OS Text's Telnyx validation filters non-mobiles).
 *
 * The Exports list holds older files too and its ordering is not trusted: the
 * download step verifies each candidate file by content (it must echo one of OUR
 * ros_ids) before accepting it. On a resume after Confirm (phase uploaded/
 * processing/completed) we skip straight to the download, never re-uploading,
 * so tokens are not double-spent.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");
const heal = require("./heal");

const CONFIG = {
  baseUrl: process.env.KOLDINFO_BASE_URL || "https://app.koldinfo.com",
  loginPath: process.env.KOLDINFO_LOGIN_PATH || "/sign-in",
  bulkPath: process.env.KOLDINFO_BULK_PATH || "/protected/enrichment",
  exportsPath: process.env.KOLDINFO_EXPORTS_PATH || "/protected/exports",

  statePath: process.env.KOLDINFO_STATE_PATH || "/data/koldinfo-state.json",
  email: process.env.KOLDINFO_EMAIL || "",
  password: process.env.KOLDINFO_PASSWORD || "",
  headed: process.env.KOLDINFO_HEADED === "1",

  navTimeoutMs: Number(process.env.KOLDINFO_NAV_TIMEOUT_MS || 60_000),
  enrichTimeoutMs: Number(process.env.KOLDINFO_ENRICH_TIMEOUT_MS || 30 * 60_000),

  // The CSV column the app should read LinkedIn URLs from (ours, from
  // buildSourcingKoldInfoCsv). Any option containing "linkedin" is the fallback.
  linkedinColumn: process.env.KOLDINFO_LINKEDIN_COLUMN || "linkedin_url",
};

/* ----------------------------------------------------------------------------- */
/* small helpers                                                                  */
/* ----------------------------------------------------------------------------- */

async function firstVisibleLoc(page, sels, timeout = 8000) {
  for (const s of sels) {
    const loc = page.locator(s).first();
    try { await loc.waitFor({ state: "visible", timeout }); return loc; } catch { /* next */ }
  }
  return null;
}

/** On the login screen? URL says sign-in/login, or a password field is on screen. */
async function onLoginPage(page) {
  if (/sign-?in|log-?in/i.test(page.url())) return true;
  try {
    await page.locator("input[type=password]").first().waitFor({ state: "visible", timeout: 2000 });
    return true;
  } catch { return false; }
}

/** Wait until the page has left the login state: no visible password field AND the URL
 *  no longer says sign-in/login. Polls, so SPA redirects and XHR logins both count. */
async function waitForLeaveLogin(page, ms) {
  try {
    await page.waitForFunction(() => {
      const pw = document.querySelector("input[type=password]");
      const pwVisible = pw && pw.offsetParent !== null;
      const onAuthUrl = /sign-?in|log-?in/i.test(location.pathname);
      return !pwVisible && !onAuthUrl;
    }, { timeout: ms, polling: 500 });
    return true;
  } catch { return false; }
}

/* ----------------------------------------------------------------------------- */
/* login + session                                                                */
/* ----------------------------------------------------------------------------- */

async function logIn(page, log) {
  if (!CONFIG.email || !CONFIG.password) {
    throw new Error("koldinfo_credentials_missing: set KOLDINFO_EMAIL and KOLDINFO_PASSWORD");
  }
  log("login: opening sign-in page");
  await page.goto(CONFIG.baseUrl + CONFIG.loginPath, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  let email = await firstVisibleLoc(page, ["input[type=email]", "input[autocomplete=email]", "input[name=email]", "#email"], 8000);
  if (!email) {
    log("login: no email field on " + CONFIG.loginPath + ", trying /login");
    await page.goto(CONFIG.baseUrl + "/login", { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(2500);
    email = await firstVisibleLoc(page, ["input[type=email]", "input[autocomplete=email]", "input[name=email]", "#email"], 8000);
  }
  const password = await firstVisibleLoc(page, ["input[type=password]", "input[autocomplete=current-password]", "input[name=password]", "#password"], 8000);
  if (!email || !password) {
    throw new Error("koldinfo_login_form_not_found (CALIBRATE: set KOLDINFO_LOGIN_PATH to the page with the email + password form)");
  }
  await email.fill(CONFIG.email);
  await password.fill(CONFIG.password);

  // Submit, most-reliable mechanism first. Plain text-click is LAST on purpose: the
  // sign-in page also has a "Sign In" HEADING, and clicking that no-ops.
  await password.press("Enter").catch(() => {});
  if (!(await waitForLeaveLogin(page, 12_000))) {
    const btn = page.locator("button[type=submit]").first();
    if (await btn.count()) { log("login: Enter did not submit, clicking button[type=submit]"); await btn.click().catch(() => {}); }
    if (!(await waitForLeaveLogin(page, 12_000))) {
      const roleBtn = page.getByRole("button", { name: /sign ?in|log ?in|continue|submit/i }).first();
      if (await roleBtn.count()) { log("login: clicking the sign-in button by role"); await roleBtn.click().catch(() => {}); }
      if (!(await waitForLeaveLogin(page, 12_000))) {
        await page.screenshot({ path: "/data/koldinfo-login-fail.png", fullPage: true }).catch(() => {});
        log("login: FAILED at " + page.url() + " (screenshot: /data/koldinfo-login-fail.png)");
        throw new Error("koldinfo_login_failed: still on the sign-in screen after submit, check credentials, or a 2FA/captcha challenge (see /data/koldinfo-login-fail.png)");
      }
    }
  }
  log("login: success");
}

async function ensureSession(context, log) {
  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.navTimeoutMs);
  log("session: opening app");
  await page.goto(CONFIG.baseUrl + CONFIG.bulkPath, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  if (await onLoginPage(page)) {
    log("session: not authenticated, logging in");
    await logIn(page, log);
    await context.storageState({ path: CONFIG.statePath });
    log("session: saved storage state");
  } else {
    log("session: reused existing login");
  }
  return page;
}

/* ----------------------------------------------------------------------------- */
/* enrich + export (calibrated against the live UI)                               */
/* ----------------------------------------------------------------------------- */

/**
 * Drive /protected/enrichment: attach the CSV, pick the LinkedIn column, preview,
 * confirm. Returns the matched-row count, or 0 when KoldInfo found nothing (in which
 * case Cancel was clicked and no tokens were spent).
 */
async function runEnrichment(page, csvPath, log) {
  await page.goto(CONFIG.baseUrl + CONFIG.bulkPath, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const fileInput = page.locator("input[type=file]").first();
  if (!(await fileInput.count())) {
    throw new Error("koldinfo_file_input_not_found (CALIBRATE: " + CONFIG.bulkPath + " no longer has a file input)");
  }
  log("upload: attaching " + path.basename(csvPath));
  await fileInput.setInputFiles(csvPath);
  await page.getByText(/Loaded \d+ rows/i).first().waitFor({ state: "visible", timeout: 30_000 })
    .catch(() => { throw new Error("koldinfo_upload_not_loaded: no 'Loaded N rows' appeared after attaching the CSV"); });
  log("upload: CSV loaded");

  // "Which column has the LinkedIn URLs?" — the first select lists OUR CSV headers.
  const colSel = page.locator("select").first();
  try {
    await colSel.selectOption({ label: CONFIG.linkedinColumn });
  } catch {
    const labels = await colSel.locator("option").allTextContents();
    const match = labels.find((l) => /linkedin/i.test(l));
    if (!match) throw new Error("koldinfo_column_select_failed: no linkedin option among [" + labels.join(", ") + "]");
    await colSel.selectOption({ label: match });
  }
  log("upload: LinkedIn column selected");
  // Second select = source table; its default ("All tables") gives the widest match.

  await page.getByRole("button", { name: /enrich preview/i }).first().click();
  const proceed = page.getByText(/it will cost\s+\S+\s+tokens?/i).first();
  await proceed.waitFor({ state: "visible", timeout: 60_000 })
    .catch(() => { throw new Error("koldinfo_preview_not_shown: no cost confirmation appeared after Enrich Preview"); });
  const costText = ((await proceed.textContent()) || "").trim();
  log("preview: " + costText);
  const found = parseInt((costText.match(/found\s+(\d+)/i) || [])[1] || "0", 10);
  if (!found) {
    log("preview: 0 matching rows, cancelling (no tokens spent)");
    await page.getByRole("button", { name: /^cancel$/i }).first().click().catch(() => {});
    return 0;
  }
  await page.getByRole("button", { name: /^confirm$/i }).first().click();
  log("enrich: confirmed, " + found + " matched row(s), " + found + " token(s)");
  return found;
}

/**
 * Poll /protected/exports until a Download hands back OUR result. The list can hold
 * older exports and its ordering is not guaranteed, so "newest row" is NOT trusted:
 * every candidate file is verified by content — it must contain one of the ros_ids
 * from OUR input CSV (KoldInfo echoes input columns back into the export). NOTE: the
 * page also shows an "Export Next Batch" control; very large runs may paginate — if a
 * result ever comes back truncated, extend this to click through remaining batches.
 */
async function downloadOurExport(page, outDir, log, inputCsv) {
  const wantIds = new Set(
    inputCsv.split(/\r?\n/).slice(1).map((l) => (l.split(",")[0] || "").trim()).filter(Boolean)
  );
  const isOurs = (text) => {
    for (const id of wantIds) if (id && text.includes(id)) return true;
    return false;
  };
  // A large enrichment paginates into SEVERAL export files (the page's "Export Next
  // Batch" control materializes the next one). Returning the first matching file used
  // to silently truncate big runs - so collect EVERY file that echoes our ros_ids,
  // drive the next-batch control while it exists, and concatenate at the end.
  const parts = [];            // matched file texts, in the order found
  const seenParts = new Set(); // content signatures, so a re-scan can't double-append
  const coveredIds = new Set();
  const countCovered = (text) => {
    for (const id of wantIds) if (!coveredIds.has(id) && text.includes(id)) coveredIds.add(id);
  };
  const deadline = Date.now() + CONFIG.enrichTimeoutMs;
  let attempt = 0;
  let fileIdx = 0;
  while (Date.now() < deadline) {
    attempt++;
    await page.goto(CONFIG.baseUrl + CONFIG.exportsPath, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const buttons = page.getByRole("button", { name: /download/i });
    const n = Math.min(await buttons.count(), 30);
    let newThisPass = 0;
    for (let i = 0; i < n; i++) {
      const waiter = page.waitForEvent("download", { timeout: 30_000 }).catch(() => null);
      await buttons.nth(i).click().catch(() => {});
      const download = await waiter;
      if (!download) continue;
      const dest = path.join(outDir, "koldinfo-result-" + fileIdx++ + ".csv");
      await download.saveAs(dest).catch(() => {});
      let text = "";
      try { text = fs.readFileSync(dest, "utf8"); } catch { continue; }
      if (!isOurs(text)) continue;
      const sig = String(text.length) + ":" + text.slice(0, 500);
      if (seenParts.has(sig)) continue;
      seenParts.add(sig);
      parts.push(text);
      countCovered(text);
      newThisPass++;
      log("export: matched our rows in " + download.suggestedFilename() + " (file " + parts.length + ", " + coveredIds.size + "/" + wantIds.size + " ids covered)");
    }
    if (parts.length) {
      // Everything covered → done. Otherwise, if the page offers another batch of OUR
      // export, materialize it and rescan; a missing/disabled control means what we
      // have IS the whole result (not every input row matches, so full id coverage
      // is not required to finish).
      if (coveredIds.size >= wantIds.size) break;
      const nextBatch = page.getByRole("button", { name: /export next batch/i }).first();
      const hasNext = (await nextBatch.count().catch(() => 0)) &&
        !(await nextBatch.isDisabled().catch(() => false));
      if (hasNext && newThisPass > 0) {
        log("export: result paginates, requesting the next batch (" + coveredIds.size + "/" + wantIds.size + " ids so far)");
        await nextBatch.click().catch(() => {});
        await page.waitForTimeout(8000);
        continue;
      }
      break; // no further batches to ask for - ship what we collected
    }
    if (attempt === 1 || attempt % 6 === 0) log("export: our result not in the list yet, waiting (" + n + " other export(s) checked)");
    await page.waitForTimeout(8000);
  }
  if (!parts.length) throw new Error("koldinfo_export_timeout: our export never appeared within the time limit");
  if (parts.length === 1) return parts[0];
  // Concatenate: first file's header + every file's data rows (dedupe exact lines).
  const header = parts[0].split(/\r?\n/, 1)[0];
  const seenRows = new Set();
  const rows = [];
  for (const text of parts) {
    for (const line of text.split(/\r?\n/).slice(1)) {
      if (!line.trim() || seenRows.has(line)) continue;
      seenRows.add(line);
      rows.push(line);
    }
  }
  log("export: combined " + parts.length + " batch files into " + rows.length + " rows");
  return header + "\n" + rows.join("\n") + "\n";
}

/* ----------------------------------------------------------------------------- */
/* public entry points (same contract as laxis-flow)                              */
/* ----------------------------------------------------------------------------- */

function launchArgs() {
  return { headless: !CONFIG.headed, args: ["--no-sandbox", "--disable-dev-shm-usage"] };
}

/**
 * Run (or RESUME) one KoldInfo bulk-find job. Same job contract as the Laxis runJob.
 * Phases: new → uploaded → processing → exported. A resume that already confirmed
 * (phase processing/completed) skips straight to the download, so tokens are never
 * double-spent by a worker restart.
 */
async function runJob(job, { log = () => {}, setPhase = () => {} } = {}) {
  const inputCsv = job.csv;
  if (typeof inputCsv !== "string" || !inputCsv) throw new Error("koldinfo_no_input_csv");

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "koldinfo-"));
  const csvPath = path.join(workDir, (job.token || "rosjob") + ".csv");
  fs.writeFileSync(csvPath, inputCsv, "utf8");

  const haveState = fs.existsSync(CONFIG.statePath);
  const browser = await chromium.launch(launchArgs());
  try {
    const context = await browser.newContext(
      haveState ? { storageState: CONFIG.statePath, acceptDownloads: true } : { acceptDownloads: true }
    );
    const page = await ensureSession(context, log);

    // Any phase at or past confirm means tokens were spent: never re-upload on resume.
    const resuming = job.phase === "uploaded" || job.phase === "processing" || job.phase === "completed";
    if (resuming) {
      log("resume: enrichment was already confirmed, going straight to the export");
    } else {
      const found = await runEnrichment(page, csvPath, log);
      if (!found) {
        // Nothing matched: hand back a header-only CSV so the merge counts 0 cleanly.
        await context.storageState({ path: CONFIG.statePath });
        return "person_email\n";
      }
      await setPhase("processing");
    }

    const result = await downloadOurExport(page, workDir, log, inputCsv);
    await setPhase("exported");
    await context.storageState({ path: CONFIG.statePath }); // refresh rotated cookies
    return result;
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** Canary: log in (healing if needed) and confirm the enrichment page + file input are
 *  reachable, without uploading anything. server.js exposes this as /selftest?kind=koldinfo. */
async function selfTest({ log = () => {} } = {}) {
  const browser = await chromium.launch(launchArgs());
  try {
    const haveState = fs.existsSync(CONFIG.statePath);
    const ctx = await browser.newContext(
      haveState ? { storageState: CONFIG.statePath, acceptDownloads: true } : { acceptDownloads: true }
    );
    const page = await ensureSession(ctx, log);
    await ctx.storageState({ path: CONFIG.statePath });
    await page.goto(CONFIG.baseUrl + CONFIG.bulkPath, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const hasInput = (await page.locator("input[type=file]").count()) > 0;
    if (!hasInput) return { ok: false, healed: false, resolvedTo: null };
    return { ok: true, healed: false, resolvedTo: CONFIG.bulkPath + " file input" };
  } finally {
    await browser.close().catch(() => {});
  }
}

// heal is kept as a dependency for future drift repair on this flow.
void heal;

module.exports = { runJob, selfTest, CONFIG };
