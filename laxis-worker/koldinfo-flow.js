/**
 * RecruiterOS · enrichment worker, the KoldInfo browser flow.
 *
 * KoldInfo (app.koldinfo.com) has no API, so this drives its real UI with a headless
 * Chromium, exactly like laxis-flow.js drives app.laxis.tech: log in once (cookies
 * persist on the volume), upload the missing-email CSV to the bulk email finder, wait
 * for the job to finish, download the result CSV, and hand the bytes back. RecruiterOS
 * merges the emails onto its candidate rows (blanks only, never overwrites).
 *
 * KoldInfo is the FREE first rung, so this flow runs BEFORE the Laxis job in the
 * auto-enrich chain: Laxis credits are then only spent on what KoldInfo could not fill.
 *
 * UNCALIBRATED ON PURPOSE: unlike laxis-flow (calibrated against the live site), this
 * flow has not been walked against KoldInfo's real UI yet. Every step is intent-based
 * with generous label candidates and self-heals through heal.js (an LLM picks the right
 * control when no known label matches, and the winner is persisted). Run
 * `GET /selftest?kind=koldinfo` (or wait for the canary) after setting credentials to
 * calibrate the login + bulk-upload entry points without spending anything. If a step
 * still can't resolve, the error names it (koldinfo_step_unresolved via heal) so the
 * fix is one label string here.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");
const heal = require("./heal");

const CONFIG = {
  baseUrl: process.env.KOLDINFO_BASE_URL || "https://app.koldinfo.com",
  // KoldInfo's sign-in lives at /sign-in (its sign-up is /sign-up); /login is tried as
  // a fallback when the primary path shows no email field.
  loginPath: process.env.KOLDINFO_LOGIN_PATH || "/sign-in",
  // Optional direct path to the bulk finder page. When empty the flow heal-clicks its
  // way there from the post-login landing page.
  bulkPath: process.env.KOLDINFO_BULK_PATH || "",

  statePath: process.env.KOLDINFO_STATE_PATH || "/data/koldinfo-state.json",
  email: process.env.KOLDINFO_EMAIL || "",
  password: process.env.KOLDINFO_PASSWORD || "",
  headed: process.env.KOLDINFO_HEADED === "1",

  navTimeoutMs: Number(process.env.KOLDINFO_NAV_TIMEOUT_MS || 60_000),
  enrichTimeoutMs: Number(process.env.KOLDINFO_ENRICH_TIMEOUT_MS || 30 * 60_000),

  // Label candidates per step (visible text). heal.js tries these first, then a learned
  // override, then asks the LLM, so a rename on KoldInfo's side repairs itself.
  text: {
    bulkEntry: ["Bulk Email Finder", "Bulk Finder", "Email Finder", "Bulk", "Bulk Upload", "Find Emails"],
    uploadOpen: ["Upload CSV", "Upload File", "Upload", "Import CSV", "Import", "Choose File"],
    start: ["Start", "Find Emails", "Upload", "Submit", "Run", "Continue", "Process"],
    signIn: ["Sign In", "Sign in", "Log In", "Log in", "Login", "Continue"],
    export: ["Download", "Export", "Download CSV", "Download Results", "Export CSV", "Results"],
  },
  selectors: {
    fileInput: "input[type=file]",
  },
};

/* ----------------------------------------------------------------------------- */
/* small helpers (same shapes as laxis-flow)                                      */
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
    // Primary path showed no form (path moved, or fields are behind an "email" choice).
    log("login: no email field on " + CONFIG.loginPath + ", trying /login");
    await page.goto(CONFIG.baseUrl + "/login", { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(2500);
    email = await firstVisibleLoc(page, ["input[type=email]", "input[autocomplete=email]", "input[name=email]", "#email"], 8000);
  }
  if (!email) {
    // Last resort: an email/password option hidden behind social buttons (Laxis-style).
    await heal.resolveClick(page, "koldinfo_login_with_email",
      "Choose to sign in / continue using an email address and password (not a social provider like Google)",
      ["Continue with Email", "Sign in with email", "Use email"], log).catch(() => {});
    await page.waitForTimeout(2000);
    email = await firstVisibleLoc(page, ["input[type=email]", "input[autocomplete=email]", "input[name=email]", "#email"], 8000);
  }
  const password = await firstVisibleLoc(page, ["input[type=password]", "input[autocomplete=current-password]", "input[name=password]", "#password"], 8000);
  if (!email || !password) {
    throw new Error("koldinfo_login_form_not_found (CALIBRATE: set KOLDINFO_LOGIN_PATH to the page with the email + password form)");
  }
  await email.fill(CONFIG.email);
  await password.fill(CONFIG.password);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    heal.resolveClick(page, "koldinfo_login_submit", "Submit / confirm the email and password login form", CONFIG.text.signIn, log),
  ]);
  await page.waitForTimeout(4000);
  if (await onLoginPage(page)) {
    throw new Error("koldinfo_login_failed: still on the sign-in screen after submit, check credentials, or a 2FA/captcha challenge");
  }
  log("login: success");
}

async function ensureSession(context, log) {
  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.navTimeoutMs);
  log("session: opening app");
  await page.goto(CONFIG.baseUrl + (CONFIG.bulkPath || "/"), { waitUntil: "domcontentloaded" });
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

/** Land on the bulk finder surface (direct path when configured, else heal-click there). */
async function gotoBulk(page, log) {
  if (CONFIG.bulkPath) {
    await page.goto(CONFIG.baseUrl + CONFIG.bulkPath, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    return;
  }
  await page.goto(CONFIG.baseUrl + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await heal.resolveClick(page, "koldinfo_bulk_entry",
    "Open the bulk email finder, the feature that finds email addresses for a whole uploaded CSV/list of people at once",
    CONFIG.text.bulkEntry, log);
  await page.waitForTimeout(2500);
}

/* ----------------------------------------------------------------------------- */
/* upload + wait + export                                                         */
/* ----------------------------------------------------------------------------- */

/** Smallest element containing our token, same idempotency scan as the Laxis flow. */
async function findJobRow(page, token) {
  return page.evaluate((tk) => {
    const all = Array.from(document.querySelectorAll("*"));
    let bestTxt = null;
    let bestSize = Infinity;
    for (const e of all) {
      const txt = e.textContent || "";
      if (txt.includes(tk)) {
        const size = e.querySelectorAll("*").length;
        if (size < bestSize) { bestSize = size; bestTxt = txt; }
      }
    }
    if (bestTxt === null) return { exists: false, status: "absent" };
    let status = "unknown";
    if (/failed|error/i.test(bestTxt)) status = "failed";
    else if (/completed|complete|done|finished|ready|processed/i.test(bestTxt)) status = "completed";
    else if (/processing|in progress|queued|pending|running/i.test(bestTxt)) status = "processing";
    return { exists: true, status };
  }, token);
}

/** Upload the CSV once (idempotent by token, so a resumed run never double-spends). */
async function ensureUploaded(page, csvPath, token, log, onUploaded) {
  await gotoBulk(page, log);

  const existing = await findJobRow(page, token);
  if (existing.exists) {
    log(`upload: row for ${token} already present (status=${existing.status}), skipping upload (resume)`);
    if (onUploaded) await onUploaded();
    return;
  }

  // File inputs are usually visually hidden; try to attach directly, and only click an
  // "upload" opener when no input exists on the page at all.
  let fileInput = page.locator(CONFIG.selectors.fileInput).first();
  if ((await fileInput.count()) === 0) {
    log("upload: no file input on page, opening the upload dialog");
    await heal.resolveClick(page, "koldinfo_upload_open",
      "Open the control/dialog for uploading a CSV file of contacts to find emails for",
      CONFIG.text.uploadOpen, log);
    await page.waitForTimeout(2000);
    fileInput = page.locator(CONFIG.selectors.fileInput).first();
  }
  if ((await fileInput.count()) === 0) {
    throw new Error("koldinfo_file_input_not_found (CALIBRATE: no input[type=file] after opening the upload dialog)");
  }
  log("upload: setting file " + path.basename(csvPath));
  await fileInput.setInputFiles(csvPath);
  await page.waitForTimeout(1500);

  log("upload: starting the bulk find");
  await heal.resolveClick(page, "koldinfo_start",
    "Start / confirm the bulk email finding now that the CSV file is attached",
    CONFIG.text.start, log).catch(() => {
      // Some uploaders auto-start on file selection; the row check below is the arbiter.
      log("upload: no start button resolved, assuming the upload auto-started");
    });

  await page.waitForFunction(
    (tk) => Array.from(document.querySelectorAll("*")).some((e) => (e.textContent || "").includes(tk)),
    token,
    { timeout: 90_000, polling: 2000 }
  ).catch(() => {
    throw new Error("koldinfo_row_not_created: uploaded the CSV but no job row appeared (UI may have changed, run /selftest?kind=koldinfo)");
  });
  log("upload: job row created");
  if (onUploaded) await onUploaded();
}

async function waitForCompletion(page, token, log) {
  log("find: waiting for completion (job token " + token + ")");
  await page.waitForFunction(
    (tk) => {
      const all = Array.from(document.querySelectorAll("*"));
      let bestTxt = null;
      let bestSize = Infinity;
      for (const e of all) {
        const txt = e.textContent || "";
        if (txt.includes(tk) && /(processing|in progress|queued|pending|running|completed|complete|done|finished|ready|processed|failed|error)/i.test(txt)) {
          const size = e.querySelectorAll("*").length;
          if (size < bestSize) { bestSize = size; bestTxt = txt; }
        }
      }
      if (bestTxt === null) return false;
      if (/processing|in progress|queued|pending|running/i.test(bestTxt)) return false;
      if (/failed|error/i.test(bestTxt)) throw new Error("koldinfo_find_failed: job reported a failure");
      return /completed|complete|done|finished|ready|processed/i.test(bestTxt);
    },
    token,
    { timeout: CONFIG.enrichTimeoutMs, polling: 5000 }
  );
  log("find: completed");
  await page.waitForTimeout(1500);
}

async function exportResult(page, token, outDir, log) {
  // Some UIs need the row opened first, others put a download control right on the row.
  // Opening the row is best-effort; the download click below is the load-bearing step.
  try {
    await page.getByText(token, { exact: false }).first().click({ timeout: 8000 });
    await page.waitForTimeout(2500);
    log("export: opened the job row");
  } catch {
    log("export: row not clickable, downloading from the list view");
  }

  log("export: downloading result CSV");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: CONFIG.navTimeoutMs }),
    heal.resolveClick(page, "koldinfo_export",
      "Download / export the finished bulk email results as a CSV file",
      CONFIG.text.export, log),
  ]);
  const dest = path.join(outDir, "koldinfo-result.csv");
  await download.saveAs(dest);
  log("export: saved " + dest);
  return fs.readFileSync(dest, "utf8");
}

/* ----------------------------------------------------------------------------- */
/* public entry points (same contract as laxis-flow)                              */
/* ----------------------------------------------------------------------------- */

function launchArgs() {
  return { headless: !CONFIG.headed, args: ["--no-sandbox", "--disable-dev-shm-usage"] };
}

/** Run (or RESUME) one KoldInfo bulk-find job. Same job contract as the Laxis runJob. */
async function runJob(job, { log = () => {}, setPhase = () => {} } = {}) {
  const inputCsv = job.csv;
  if (typeof inputCsv !== "string" || !inputCsv) throw new Error("koldinfo_no_input_csv");
  const token = job.token;
  if (!token) throw new Error("koldinfo_no_token");

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "koldinfo-"));
  const csvPath = path.join(workDir, token + ".csv");
  fs.writeFileSync(csvPath, inputCsv, "utf8");

  const haveState = fs.existsSync(CONFIG.statePath);
  const browser = await chromium.launch(launchArgs());
  try {
    const context = await browser.newContext(
      haveState ? { storageState: CONFIG.statePath, acceptDownloads: true } : { acceptDownloads: true }
    );
    const page = await ensureSession(context, log);
    await ensureUploaded(page, csvPath, token, log, async () => { await setPhase("uploaded"); });
    await setPhase("processing");
    await waitForCompletion(page, token, log);
    await setPhase("completed");
    const result = await exportResult(page, token, workDir, log);
    await setPhase("exported");
    await context.storageState({ path: CONFIG.statePath }); // refresh rotated cookies
    return result;
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** Canary: log in (healing the steps if needed) and confirm the bulk entry is locatable,
 *  without uploading anything. server.js exposes this as /selftest?kind=koldinfo. */
async function selfTest({ log = () => {} } = {}) {
  const browser = await chromium.launch(launchArgs());
  try {
    const haveState = fs.existsSync(CONFIG.statePath);
    const ctx = await browser.newContext(
      haveState ? { storageState: CONFIG.statePath, acceptDownloads: true } : { acceptDownloads: true }
    );
    const page = await ensureSession(ctx, log);
    await ctx.storageState({ path: CONFIG.statePath });
    if (CONFIG.bulkPath) {
      await page.goto(CONFIG.baseUrl + CONFIG.bulkPath, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      const hasInput = (await page.locator(CONFIG.selectors.fileInput).count()) > 0;
      return { ok: true, healed: false, resolvedTo: hasInput ? "file input on KOLDINFO_BULK_PATH" : "bulk path reachable" };
    }
    await page.goto(CONFIG.baseUrl + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const r = await heal.resolveLocate(page, "koldinfo_bulk_entry",
      "Open the bulk email finder, the feature that finds email addresses for a whole uploaded CSV/list of people at once",
      CONFIG.text.bulkEntry, log);
    return { ok: r.ok, healed: r.healed, resolvedTo: r.text };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { runJob, selfTest, CONFIG };
